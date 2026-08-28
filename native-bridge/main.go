package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const bridgeVersion = "relay-mcp-bridge-v1"

type descriptor struct {
	Protocol       int    `json:"protocol"`
	ConfigScopeID  string `json:"configScopeId"`
	DomainID       string `json:"domainId"`
	CapabilityFile string `json:"capabilityFile"`
	Endpoint       string `json:"endpoint"`
	BrokerNode     string `json:"brokerNode"`
	BrokerEntry    string `json:"brokerEntry"`
}

type hello struct {
	Type           string            `json:"type"`
	Protocol       int               `json:"protocol"`
	Capability     string            `json:"capability"`
	DomainID       string            `json:"domainId"`
	BridgePID      int               `json:"bridgePid"`
	CWD            string            `json:"cwd"`
	ChannelEnabled bool              `json:"channelEnabled"`
	ChannelSource  string            `json:"channelSource"`
	Env            map[string]string `json:"env"`
}

type ready struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	Message  string `json:"message"`
}

func readDescriptor(name string) (descriptor, []byte, error) {
	var out descriptor
	body, err := os.ReadFile(name)
	if err != nil {
		return out, nil, fmt.Errorf("read broker descriptor: %w", err)
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, nil, fmt.Errorf("parse broker descriptor: %w", err)
	}
	if out.Protocol != 1 || out.ConfigScopeID == "" || out.DomainID == "" || out.Endpoint == "" || out.BrokerNode == "" || out.BrokerEntry == "" || out.CapabilityFile == "" {
		return out, nil, errors.New("broker descriptor is incomplete; run relay repair-installation")
	}
	capability, err := os.ReadFile(filepath.Join(filepath.Dir(name), out.CapabilityFile))
	if err != nil {
		return out, nil, fmt.Errorf("read broker capability: %w", err)
	}
	if len(capability) != 32 {
		return out, nil, errors.New("broker capability has an invalid length; run relay repair-installation")
	}
	return out, capability, nil
}

func sessionEnvironment() map[string]string {
	out := map[string]string{}
	for _, key := range []string{"CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "RELAY_CALLING_NATIVE_SESSION_ID"} {
		if value := os.Getenv(key); value != "" {
			out[key] = value
		}
	}
	return out
}

func startupDeadline() time.Time {
	if raw := os.Getenv("RELAY_MCP_START_DEADLINE_MS"); raw != "" {
		if millis, err := strconv.ParseInt(raw, 10, 64); err == nil && millis > 0 {
			return time.UnixMilli(millis)
		}
	}
	return time.Now().Add(30 * time.Second)
}

func brokerEnvironment() []string {
	blocked := map[string]bool{
		"CODEX_THREAD_ID": true, "CLAUDE_CODE_SESSION_ID": true, "CLAUDE_SESSION_ID": true,
		"RELAY_CALLING_NATIVE_SESSION_ID": true, "RELAY_CHANNEL_PUMP": true,
	}
	out := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if !blocked[key] {
			out = append(out, entry)
		}
	}
	return out
}

type helloResult struct {
	reader   *bufio.Reader
	response ready
	err      error
}

func readHello(connection io.ReadWriteCloser, deadline time.Time) (*bufio.Reader, ready, error) {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil, ready{}, errors.New("broker handshake exceeded the startup deadline")
	}
	result := make(chan helloResult, 1)
	go func() {
		reader := bufio.NewReaderSize(connection, 16*1024)
		line, err := reader.ReadString('\n')
		if err != nil {
			result <- helloResult{err: fmt.Errorf("read broker hello: %w", err)}
			return
		}
		if len(line) > 16*1024 {
			result <- helloResult{err: errors.New("broker hello exceeded its size limit")}
			return
		}
		var response ready
		if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &response); err != nil {
			result <- helloResult{err: fmt.Errorf("parse broker hello: %w", err)}
			return
		}
		result <- helloResult{reader: reader, response: response}
	}()
	select {
	case value := <-result:
		return value.reader, value.response, value.err
	case <-time.After(remaining):
		_ = connection.Close()
		return nil, ready{}, errors.New("broker handshake exceeded the startup deadline")
	}
}

func connect(desc descriptor, request hello, deadline time.Time) (io.ReadWriteCloser, *bufio.Reader, error) {
	delays := []time.Duration{25, 50, 100, 200, 400, 500}
	started := false
	attempt := 0
	var last error
	for time.Now().Before(deadline) {
		connection, err := openEndpoint(desc.Endpoint)
		if err != nil {
			last = err
		}
		if err != nil && !started {
			started = true
			if err := startDetached(desc.BrokerNode, []string{
				"--max-old-space-size=512",
				desc.BrokerEntry,
				"--config-scope=" + desc.ConfigScopeID,
				"--domain=" + desc.DomainID,
			}, brokerEnvironment()); err != nil {
				last = err
			}
		}
		if err == nil {
			body, _ := json.Marshal(request)
			if _, err := connection.Write(append(body, '\n')); err == nil {
				reader, response, helloErr := readHello(connection, deadline)
				if helloErr == nil && response.Type == "relay-mcp-broker/ready" && response.Protocol == desc.Protocol {
					return connection, reader, nil
				}
				if helloErr == nil && response.Message != "" {
					_ = connection.Close()
					return nil, nil, errors.New(response.Message)
				}
				if helloErr != nil {
					last = helloErr
				} else {
					last = errors.New("broker returned an invalid handshake")
				}
			} else {
				last = err
			}
			_ = connection.Close()
		}
		delay := delays[min(attempt, len(delays)-1)] * time.Millisecond
		attempt++
		if time.Now().Add(delay).After(deadline) {
			break
		}
		time.Sleep(delay)
	}
	return nil, nil, fmt.Errorf("broker did not become ready before the startup deadline: %w", last)
}

func proxy(connection io.ReadWriteCloser, reader *bufio.Reader) error {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	type copyResult struct {
		fromBroker bool
		err        error
	}
	done := make(chan copyResult, 2)
	go func() {
		_, err := io.Copy(connection, os.Stdin)
		done <- copyResult{err: err}
	}()
	go func() {
		_, err := io.Copy(os.Stdout, reader)
		done <- copyResult{fromBroker: true, err: err}
	}()
	select {
	case result := <-done:
		if result.err != nil {
			return result.err
		}
		if result.fromBroker {
			return errors.New("Relay MCP broker connection closed; reload Relay MCP in this host")
		}
		return nil
	case <-signals:
		return nil
	}
}

func run(descriptorPath string) error {
	desc, capability, err := readDescriptor(descriptorPath)
	if err != nil {
		return err
	}
	configRoot := filepath.Clean(filepath.Join(filepath.Dir(descriptorPath), "..", ".."))
	if err := os.Setenv("RELAY_CONFIG_DIR", configRoot); err != nil {
		return fmt.Errorf("bind broker config root: %w", err)
	}
	deadline := startupDeadline()
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("resolve bridge cwd: %w", err)
	}
	channelEnabled := os.Getenv("RELAY_CHANNEL_PUMP") == "1"
	channelSource := "none"
	if channelEnabled {
		channelSource = "relay-channel-pump-env"
	}
	request := hello{
		Type: "relay-mcp-broker/hello", Protocol: desc.Protocol,
		Capability: base64.RawURLEncoding.EncodeToString(capability), DomainID: desc.DomainID,
		BridgePID: os.Getpid(), CWD: cwd, ChannelEnabled: channelEnabled,
		ChannelSource: channelSource, Env: sessionEnvironment(),
	}
	connection, reader, err := connect(desc, request, deadline)
	if err != nil {
		return err
	}
	defer connection.Close()
	return proxy(connection, reader)
}

func main() {
	descriptorPath := flag.String("descriptor", "", "protected Relay MCP broker descriptor")
	version := flag.Bool("version", false, "print bridge protocol version")
	flag.Parse()
	if *version {
		fmt.Println(bridgeVersion)
		return
	}
	if *descriptorPath == "" {
		fmt.Fprintln(os.Stderr, "relay: --descriptor is required")
		os.Exit(2)
	}
	if err := run(*descriptorPath); err != nil {
		fmt.Fprintln(os.Stderr, "relay:", err)
		os.Exit(1)
	}
}

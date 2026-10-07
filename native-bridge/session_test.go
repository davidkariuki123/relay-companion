package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBroker answers like the real one: initialize, tools/list (labelled with
// which broker answered) and a tools/call that never returns.
type fakeBroker struct {
	name     string
	conn     net.Conn
	mu       sync.Mutex
	received []string
}

func (b *fakeBroker) serve() {
	reader := bufio.NewReader(b.conn)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		f := parseFrame(line)
		b.mu.Lock()
		b.received = append(b.received, f.method+" "+f.id)
		b.mu.Unlock()
		if !f.isRequest() {
			continue
		}
		var result string
		switch f.method {
		case "initialize":
			result = `{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"relay","version":"1"}}`
		case "tools/list":
			result = `{"tools":[{"name":"` + b.name + `"}]}`
		default:
			continue
		}
		_, _ = b.conn.Write([]byte(`{"jsonrpc":"2.0","id":` + f.id + `,"result":` + result + "}\n"))
	}
}

func (b *fakeBroker) log() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.received...)
}

type harness struct {
	t        *testing.T
	session  *session
	hostIn   *io.PipeWriter
	hostOut  *bufio.Reader
	mu       sync.Mutex
	brokers  []*fakeBroker
	refuse   bool
	finished chan error
}

func newHarness(t *testing.T) *harness {
	h := &harness{t: t, finished: make(chan error, 1)}
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()
	h.hostIn = stdinWriter
	h.hostOut = bufio.NewReader(stdoutReader)
	dial := func(time.Time) (io.ReadWriteCloser, *bufio.Reader, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.refuse {
			return nil, nil, errors.New("connection refused")
		}
		return h.newBroker()
	}
	h.session = newSession(dial, stdoutWriter)
	h.session.logf = func(string, ...any) {}
	h.session.retryDelays = []time.Duration{10 * time.Millisecond}
	h.session.tick = 10 * time.Millisecond
	h.mu.Lock()
	conn, reader, _ := h.newBroker()
	h.mu.Unlock()
	go func() { h.finished <- h.session.run(conn, reader, stdinReader) }()
	t.Cleanup(func() {
		_ = stdinWriter.Close()
		select {
		case <-h.finished:
		case <-time.After(2 * time.Second):
			t.Error("bridge did not exit after the host closed stdin")
		}
	})
	return h
}

// newBroker must be called with h.mu held.
func (h *harness) newBroker() (io.ReadWriteCloser, *bufio.Reader, error) {
	bridgeSide, brokerSide := net.Pipe()
	broker := &fakeBroker{name: "broker" + string(rune('A'+len(h.brokers))), conn: brokerSide}
	h.brokers = append(h.brokers, broker)
	go broker.serve()
	return bridgeSide, bufio.NewReader(bridgeSide), nil
}

func (h *harness) broker(index int) *fakeBroker {
	h.mu.Lock()
	defer h.mu.Unlock()
	if index >= len(h.brokers) {
		return nil
	}
	return h.brokers[index]
}

func (h *harness) send(line string) {
	h.t.Helper()
	if _, err := h.hostIn.Write([]byte(line + "\n")); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) read() map[string]any {
	h.t.Helper()
	type result struct {
		line string
		err  error
	}
	got := make(chan result, 1)
	go func() {
		line, err := h.hostOut.ReadString('\n')
		got <- result{line, err}
	}()
	select {
	case value := <-got:
		if value.err != nil {
			h.t.Fatal(value.err)
		}
		var message map[string]any
		if err := json.Unmarshal([]byte(value.line), &message); err != nil {
			h.t.Fatalf("host received invalid JSON %q: %v", value.line, err)
		}
		return message
	case <-time.After(3 * time.Second):
		h.t.Fatal("host received nothing")
		return nil
	}
}

func (h *harness) initialize() {
	h.t.Helper()
	h.send(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-ai","version":"1"}}}`)
	if reply := h.read(); reply["id"] != float64(0) || reply["result"] == nil {
		h.t.Fatalf("initialize reply = %v", reply)
	}
	h.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
}

func toolName(t *testing.T, reply map[string]any) string {
	t.Helper()
	result, _ := reply["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools/list reply = %v", reply)
	}
	return tools[0].(map[string]any)["name"].(string)
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestBridgeSurvivesBrokerRestart(t *testing.T) {
	h := newHarness(t)
	h.initialize()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if name := toolName(t, h.read()); name != "brokerA" {
		t.Fatalf("first catalogue came from %s", name)
	}

	_ = h.broker(0).conn.Close()

	// The host is told the catalogue may have changed, and re-lists.
	if notice := h.read(); notice["method"] != "notifications/tools/list_changed" {
		t.Fatalf("expected tools/list_changed, got %v", notice)
	}
	h.send(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if name := toolName(t, h.read()); name != "brokerB" {
		t.Fatalf("catalogue after restart came from %s", name)
	}
	// The new broker saw the replayed handshake before any host request, under
	// an id the host never used.
	log := h.broker(1).log()
	if len(log) < 3 || !strings.HasPrefix(log[0], "initialize \""+reinitializeIDPrefix) || log[1] != "notifications/initialized " || log[2] != "tools/list 2" {
		t.Fatalf("second broker received %v", log)
	}
}

func TestInterruptedCallsAreAnsweredNotRepeated(t *testing.T) {
	h := newHarness(t)
	h.initialize()
	h.send(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"relay_send"}}`)
	waitFor(t, "the call to reach the broker", func() bool {
		for _, entry := range h.broker(0).log() {
			if entry == "tools/call 7" {
				return true
			}
		}
		return false
	})
	_ = h.broker(0).conn.Close()

	reply := h.read()
	if reply["id"] != float64(7) {
		t.Fatalf("expected an answer for the interrupted call, got %v", reply)
	}
	message := reply["error"].(map[string]any)["message"].(string)
	if !strings.Contains(message, "may or may not have finished") {
		t.Fatalf("interrupted call error = %q", message)
	}
	if notice := h.read(); notice["method"] != "notifications/tools/list_changed" {
		t.Fatalf("expected tools/list_changed, got %v", notice)
	}
	for _, entry := range h.broker(1).log() {
		if strings.HasPrefix(entry, "tools/call") {
			t.Fatalf("interrupted tool call was repeated on the new broker: %v", h.broker(1).log())
		}
	}
}

func TestRequestsWaitForTheNextBrokerThenExpire(t *testing.T) {
	h := newHarness(t)
	h.session.queueTimeout = 150 * time.Millisecond
	h.initialize()
	h.mu.Lock()
	h.refuse = true
	h.mu.Unlock()
	_ = h.broker(0).conn.Close()
	time.Sleep(30 * time.Millisecond)

	h.send(`{"jsonrpc":"2.0","id":3,"method":"tools/list"}`)
	reply := h.read()
	if reply["id"] != float64(3) || !strings.Contains(reply["error"].(map[string]any)["message"].(string), "not running") {
		t.Fatalf("expected a not-running error, got %v", reply)
	}

	// Relay comes back: the next request is served normally.
	h.mu.Lock()
	h.refuse = false
	h.mu.Unlock()
	if notice := h.read(); notice["method"] != "notifications/tools/list_changed" {
		t.Fatalf("expected tools/list_changed, got %v", notice)
	}
	h.send(`{"jsonrpc":"2.0","id":4,"method":"tools/list"}`)
	if name := toolName(t, h.read()); name != "brokerB" {
		t.Fatalf("catalogue after recovery came from %s", name)
	}
}

func TestHeldReadsAreReplayedOnTheNextBroker(t *testing.T) {
	h := newHarness(t)
	h.session.queueTimeout = 5 * time.Second
	h.initialize()
	h.mu.Lock()
	h.refuse = true
	h.mu.Unlock()
	_ = h.broker(0).conn.Close()
	time.Sleep(30 * time.Millisecond)
	h.send(`{"jsonrpc":"2.0","id":5,"method":"tools/list"}`)
	time.Sleep(30 * time.Millisecond)
	h.mu.Lock()
	h.refuse = false
	h.mu.Unlock()
	first, second := h.read(), h.read()
	if first["method"] != nil {
		first, second = second, first
	}
	if name := toolName(t, first); name != "brokerB" {
		t.Fatalf("held read was answered by %s", name)
	}
	if second["method"] != "notifications/tools/list_changed" {
		t.Fatalf("expected tools/list_changed, got %v", second)
	}
}

func TestParseFrameClassifiesMessages(t *testing.T) {
	cases := map[string][2]string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`:   {"1", "tools/list"},
		`{"jsonrpc":"2.0","id":"a b","result":{}}`:         {`"a b"`, ""},
		`{"jsonrpc":"2.0","method":"notifications/x"}`:     {"", "notifications/x"},
		`{"jsonrpc":"2.0","id":null,"error":{"code":1}}`:   {"", ""},
		`[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]`: {"", ""},
	}
	for line, want := range cases {
		f := parseFrame([]byte(line))
		if f.id != want[0] || f.method != want[1] {
			t.Errorf("parseFrame(%s) = (%q, %q), want (%q, %q)", line, f.id, f.method, want[0], want[1])
		}
		if !strings.HasSuffix(string(f.line), "\n") {
			t.Errorf("parseFrame(%s) dropped the newline", line)
		}
	}
}

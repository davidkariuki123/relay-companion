package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"
)

// The bridge is the process the host app spawned, and it is the only part of
// Relay the host ever sees. Claude Desktop never restarts a stdio server it
// lost: if this process exits, Relay's tools are gone from that app until the
// person quits it entirely. The broker behind it, though, belongs to one exact
// release and is deliberately stopped whenever Relay updates or its services
// restart. So the bridge outlives its broker: it keeps the host's stdio open,
// dials whichever broker the descriptor names now, replays the host's
// initialize on the new connection and carries on.
//
// Requests that were inside the old broker when it went away are not retried
// blindly. A tool call may already have sent a Relay; repeating it could send it
// twice. Reads that cannot change anything are resent; everything else gets an
// error saying plainly that it may or may not have finished.

const (
	reinitializeIDPrefix   = "relay-bridge-reinitialize-"
	maxQueuedFrames        = 256
	maxQueuedBytes         = 16 * 1024 * 1024
	restartedMidRequest    = "Relay restarted on this computer while this request was running (usually an update), so it may or may not have finished. Check before trying again."
	relayNotRunningMessage = "Relay is not running on this computer right now, so this request was not delivered. Relay usually comes back within a few seconds; if it does not, open the Relay app."
	queueFullMessage       = "Relay is restarting on this computer and too many requests are waiting. Try again in a moment."
)

// Requests a broker can receive twice without changing anything.
var replayableMethods = map[string]bool{
	"initialize":               true,
	"ping":                     true,
	"tools/list":               true,
	"prompts/list":             true,
	"prompts/get":              true,
	"resources/list":           true,
	"resources/templates/list": true,
	"resources/read":           true,
	"completion/complete":      true,
	"logging/setLevel":         true,
}

type frame struct {
	line   []byte // one JSON-RPC message, newline-terminated
	id     string // compact JSON id, "" when the message has none
	method string
}

func (f frame) isRequest() bool  { return f.method != "" && f.id != "" }
func (f frame) isResponse() bool { return f.method == "" && f.id != "" }

func parseFrame(line []byte) frame {
	if len(line) == 0 || line[len(line)-1] != '\n' {
		line = append(line, '\n')
	}
	out := frame{line: line}
	var envelope struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	// Anything that is not a single JSON-RPC object (a batch, garbage) is passed
	// through untouched; the broker answers it as it always has.
	if json.Unmarshal(line, &envelope) != nil {
		return out
	}
	out.method = envelope.Method
	if id := bytes.TrimSpace(envelope.ID); len(id) > 0 && !bytes.Equal(id, []byte("null")) {
		var compact bytes.Buffer
		if json.Compact(&compact, id) == nil {
			out.id = compact.String()
		} else {
			out.id = string(id)
		}
	}
	return out
}

func errorResponse(id string, message string) []byte {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
		"error":   map[string]any{"code": -32000, "message": message},
	})
	return append(body, '\n')
}

// withID returns the same JSON-RPC message carrying a different id.
func withID(line []byte, id string) ([]byte, error) {
	var message map[string]json.RawMessage
	if err := json.Unmarshal(line, &message); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(id)
	message["id"] = encoded
	body, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	return append(body, '\n'), nil
}

var (
	initializedNotification  = []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n")
	toolsChangedNotification = []byte(`{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}` + "\n")
)

type dialFunc func(deadline time.Time) (io.ReadWriteCloser, *bufio.Reader, error)

type queued struct {
	frame frame
	since time.Time
	seq   uint64
}

type inFlight struct {
	frame frame
	seq   uint64
}

type eventKind int

const (
	evStdin eventKind = iota
	evStdinClosed
	evBroker
	evBrokerClosed
	evReconnected
)

type event struct {
	kind   eventKind
	gen    int
	frame  frame
	err    error
	conn   io.ReadWriteCloser
	reader *bufio.Reader
	extra  [][]byte
}

type session struct {
	dial           dialFunc
	out            io.Writer
	logf           func(format string, args ...any)
	connectWindow  time.Duration // how long one reconnect attempt may take
	retryDelays    []time.Duration
	queueTimeout   time.Duration // how long a request may wait for a broker
	tick           time.Duration
	now            func() time.Time
	signals        <-chan os.Signal
	events         chan event
	done           chan struct{}
	conn           io.ReadWriteCloser
	gen            int
	seq            uint64
	pending        map[string]inFlight
	queue          []queued
	queuedBytes    int
	initialize     *frame // the host's own initialize request
	initialized    bool   // ...and the broker has answered it
	reconnectCount int
}

func newSession(dial dialFunc, out io.Writer) *session {
	return &session{
		dial:          dial,
		out:           out,
		logf:          func(format string, args ...any) { fmt.Fprintf(os.Stderr, "relay: "+format+"\n", args...) },
		connectWindow: 15 * time.Second,
		retryDelays:   []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second, 5 * time.Second},
		queueTimeout:  45 * time.Second,
		tick:          time.Second,
		now:           time.Now,
		events:        make(chan event, 64),
		done:          make(chan struct{}),
		pending:       map[string]inFlight{},
	}
}

func (s *session) write(line []byte) {
	if _, err := s.out.Write(line); err != nil {
		s.logf("write to host failed: %v", err)
	}
}

func (s *session) post(ev event) bool {
	select {
	case s.events <- ev:
		return true
	case <-s.done:
		return false
	}
}

func readFrames(reader *bufio.Reader, emit func(frame) bool) error {
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if !emit(parseFrame(line)) {
				return nil
			}
		}
		if err != nil {
			return err
		}
	}
}

func (s *session) attach(conn io.ReadWriteCloser, reader *bufio.Reader) {
	s.conn = conn
	gen := s.gen
	go func() {
		err := readFrames(reader, func(f frame) bool { return s.post(event{kind: evBroker, gen: gen, frame: f}) })
		s.post(event{kind: evBrokerClosed, gen: gen, err: err})
	}()
}

// send hands a host message to the live broker, or holds it until one returns.
func (s *session) send(f frame) {
	if f.method == "initialize" && f.id != "" {
		copied := f
		s.initialize = &copied
		s.initialized = false
	}
	if s.conn == nil {
		s.hold(f)
		return
	}
	s.seq++
	if f.isRequest() {
		s.pending[f.id] = inFlight{frame: f, seq: s.seq}
	}
	if _, err := s.conn.Write(f.line); err != nil {
		// The reader sees the same failure and runs the recovery; the request is
		// already recorded, so it is answered or replayed there.
		s.logf("write to broker failed: %v", err)
		s.lost(err)
	}
}

func (s *session) hold(f frame) {
	// A host's answer to a request from the old broker has nowhere to go.
	if f.isResponse() {
		return
	}
	if len(s.queue) >= maxQueuedFrames || s.queuedBytes+len(f.line) > maxQueuedBytes {
		if f.isRequest() {
			s.write(errorResponse(f.id, queueFullMessage))
		}
		return
	}
	s.seq++
	s.queue = append(s.queue, queued{frame: f, since: s.now(), seq: s.seq})
	s.queuedBytes += len(f.line)
}

func (s *session) fromBroker(f frame) {
	if f.isResponse() {
		delete(s.pending, f.id)
		if s.initialize != nil && f.id == s.initialize.id {
			s.initialized = true
		}
	}
	s.write(f.line)
}

// lost runs once per broker connection, when it fails.
func (s *session) lost(cause error) {
	if s.conn == nil {
		return
	}
	_ = s.conn.Close()
	s.conn = nil
	s.gen++
	s.logf("broker connection closed (%v); reconnecting", cause)

	interrupted := make([]inFlight, 0, len(s.pending))
	for _, request := range s.pending {
		interrupted = append(interrupted, request)
	}
	s.pending = map[string]inFlight{}
	sort.Slice(interrupted, func(i, j int) bool { return interrupted[i].seq < interrupted[j].seq })
	replay := make([]queued, 0, len(interrupted))
	now := s.now()
	for _, request := range interrupted {
		if replayableMethods[request.frame.method] {
			replay = append(replay, queued{frame: request.frame, since: now, seq: request.seq})
			s.queuedBytes += len(request.frame.line)
		} else {
			s.write(errorResponse(request.frame.id, restartedMidRequest))
		}
	}
	s.queue = append(replay, s.queue...)

	// Only a host whose initialize was answered needs one replayed for it. If it
	// was still waiting, its own request is in the replay above.
	var reinitialize []byte
	if s.initialize != nil && s.initialized {
		s.reconnectCount++
		line, err := withID(s.initialize.line, fmt.Sprintf("%s%d", reinitializeIDPrefix, s.reconnectCount))
		if err == nil {
			reinitialize = line
		}
	}
	go s.reconnect(s.gen, reinitialize)
}

func (s *session) sleep(delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-s.done:
		return false
	}
}

func (s *session) reconnect(gen int, reinitialize []byte) {
	for attempt := 0; ; attempt++ {
		select {
		case <-s.done:
			return
		default:
		}
		deadline := time.Now().Add(s.connectWindow)
		conn, reader, err := s.dial(deadline)
		if err == nil {
			var extra [][]byte
			if reinitialize != nil {
				extra, err = replayInitialize(conn, reader, reinitialize, deadline)
			}
			if err == nil {
				if !s.post(event{kind: evReconnected, gen: gen, conn: conn, reader: reader, extra: extra}) {
					_ = conn.Close()
				}
				return
			}
			_ = conn.Close()
		}
		if attempt == 0 || attempt%10 == 0 {
			s.logf("broker not reachable yet: %v", err)
		}
		if !s.sleep(s.retryDelays[min(attempt, len(s.retryDelays)-1)]) {
			return
		}
	}
}

// replayInitialize repeats the host's initialize on a fresh broker connection
// and swallows the answer, so the new broker session is in the state the host
// believes it is in. Anything else the broker says first is handed back to be
// forwarded.
func replayInitialize(conn io.ReadWriteCloser, reader *bufio.Reader, line []byte, deadline time.Time) ([][]byte, error) {
	expected := parseFrame(line).id
	if _, err := conn.Write(line); err != nil {
		return nil, err
	}
	type result struct {
		extra [][]byte
		err   error
	}
	done := make(chan result, 1)
	go func() {
		var extra [][]byte
		for {
			raw, err := reader.ReadBytes('\n')
			if err != nil {
				done <- result{err: fmt.Errorf("broker closed during initialize replay: %w", err)}
				return
			}
			f := parseFrame(raw)
			if f.isResponse() && f.id == expected {
				var reply struct {
					Error *struct {
						Message string `json:"message"`
					} `json:"error"`
				}
				if json.Unmarshal(raw, &reply) == nil && reply.Error != nil {
					done <- result{err: errors.New("broker refused initialize replay: " + reply.Error.Message)}
					return
				}
				done <- result{extra: extra}
				return
			}
			extra = append(extra, f.line)
		}
	}()
	select {
	case value := <-done:
		if value.err != nil {
			return nil, value.err
		}
		if _, err := conn.Write(initializedNotification); err != nil {
			return nil, err
		}
		return value.extra, nil
	case <-time.After(time.Until(deadline)):
		_ = conn.Close()
		return nil, errors.New("broker did not answer initialize replay before the deadline")
	}
}

func (s *session) reconnected(ev event) {
	s.attach(ev.conn, ev.reader)
	s.logf("broker reconnected")
	for _, line := range ev.extra {
		s.write(line)
	}
	queue := s.queue
	s.queue = nil
	s.queuedBytes = 0
	for _, held := range queue {
		if s.conn == nil {
			s.hold(held.frame)
			continue
		}
		s.send(held.frame)
	}
	// A different release may serve a different catalogue. The broker declares
	// tools.listChanged, so the host is entitled to this and re-lists.
	if s.initialized {
		s.write(toolsChangedNotification)
	}
}

func (s *session) expire() {
	if s.conn != nil || len(s.queue) == 0 {
		return
	}
	cutoff := s.now().Add(-s.queueTimeout)
	kept := s.queue[:0]
	s.queuedBytes = 0
	for _, held := range s.queue {
		if held.since.After(cutoff) {
			kept = append(kept, held)
			s.queuedBytes += len(held.frame.line)
			continue
		}
		if held.frame.isRequest() {
			s.write(errorResponse(held.frame.id, relayNotRunningMessage))
		}
	}
	s.queue = kept
}

func (s *session) run(conn io.ReadWriteCloser, reader *bufio.Reader, stdin io.Reader) error {
	defer close(s.done)
	s.attach(conn, reader)
	defer func() {
		if s.conn != nil {
			_ = s.conn.Close()
		}
	}()
	go func() {
		err := readFrames(bufio.NewReaderSize(stdin, 64*1024), func(f frame) bool { return s.post(event{kind: evStdin, frame: f}) })
		s.post(event{kind: evStdinClosed, err: err})
	}()
	ticker := time.NewTicker(s.tick)
	defer ticker.Stop()
	for {
		select {
		case ev := <-s.events:
			switch ev.kind {
			case evStdin:
				s.send(ev.frame)
			case evStdinClosed:
				if ev.err != nil && !errors.Is(ev.err, io.EOF) {
					return ev.err
				}
				return nil
			case evBroker:
				if ev.gen == s.gen {
					s.fromBroker(ev.frame)
				}
			case evBrokerClosed:
				if ev.gen == s.gen {
					cause := ev.err
					if cause == nil || errors.Is(cause, io.EOF) {
						cause = errors.New("broker exited")
					}
					s.lost(cause)
				}
			case evReconnected:
				if ev.gen == s.gen && s.conn == nil {
					s.reconnected(ev)
				} else {
					_ = ev.conn.Close()
				}
			}
		case <-ticker.C:
			s.expire()
		case <-s.signals:
			return nil
		}
	}
}

func proxy(dial dialFunc, connection io.ReadWriteCloser, reader *bufio.Reader) error {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	s := newSession(dial, os.Stdout)
	s.signals = signals
	return s.run(connection, reader, os.Stdin)
}

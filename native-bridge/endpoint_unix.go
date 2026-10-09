//go:build !windows

package main

import (
	"io"
	"net"
	"os/exec"
	"syscall"
)

func openEndpoint(endpoint string) (io.ReadWriteCloser, error) {
	return net.Dial("unix", endpoint)
}

func startDetached(command string, args []string, env []string) error {
	child := exec.Command(command, args...)
	child.Stdin = nil
	child.Stdout = nil
	child.Stderr = nil
	child.Env = env
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := child.Start(); err != nil {
		return err
	}
	// Reap it. Release() only forgets the child: every broker launch that found
	// a broker already running exited at once and stayed a zombie of this
	// bridge, ~180 per bridge over two days, until David's Mac hit its 4000
	// process limit and nothing could start (2026-10-09). A long-lived broker
	// just keeps this goroutine waiting; if the bridge exits first, launchd
	// inherits the broker as before.
	go func() { _ = child.Wait() }()
	return nil
}

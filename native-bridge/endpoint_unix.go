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
	return child.Process.Release()
}

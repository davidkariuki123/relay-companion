//go:build windows

package main

import (
	"io"
	"os"
	"os/exec"
	"syscall"
)

func openEndpoint(endpoint string) (io.ReadWriteCloser, error) {
	// Named pipes opened in blocking mode cannot safely sustain the bridge's
	// simultaneous stdin->broker and broker->stdout copies. Go recognizes the
	// Windows overlapped flag and routes both directions through independent
	// completion operations.
	return os.OpenFile(endpoint, os.O_RDWR|syscall.FILE_FLAG_OVERLAPPED, 0)
}

func startDetached(command string, args []string, env []string) error {
	child := exec.Command(command, args...)
	child.Stdin = nil
	child.Stdout = nil
	child.Stderr = nil
	child.Env = env
	child.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x00000200,
		HideWindow:    true,
	}
	if err := child.Start(); err != nil {
		return err
	}
	return child.Process.Release()
}

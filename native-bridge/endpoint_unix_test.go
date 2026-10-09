//go:build !windows

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func zombieChildren(t *testing.T) int {
	t.Helper()
	out, err := exec.Command("ps", "-Ao", "ppid=,stat=").Output()
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	self := strconv.Itoa(os.Getpid())
	count := 0
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == self && strings.HasPrefix(fields[1], "Z") {
			count++
		}
	}
	return count
}

// A broker launch that exits at once (one is already running) must not stay a
// zombie of the bridge: they filled David's process table (2026-10-09).
func TestStartDetachedReapsChildrenThatExit(t *testing.T) {
	for i := 0; i < 20; i++ {
		if err := startDetached("/bin/sh", []string{"-c", "exit 0"}, os.Environ()); err != nil {
			t.Fatalf("startDetached: %v", err)
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		zombies := zombieChildren(t)
		if zombies == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d broker launches left as zombies of the bridge", zombies)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

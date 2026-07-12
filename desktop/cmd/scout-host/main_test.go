package main

import (
	"os"
	"testing"
)

func TestConfiguredPort(t *testing.T) {
	t.Setenv("SCOUT_PORT", "8460")
	if got := configuredPort(); got != 8460 {
		t.Fatalf("configuredPort() = %d", got)
	}
	if err := os.Setenv("SCOUT_PORT", "bad"); err != nil {
		t.Fatal(err)
	}
	if got := configuredPort(); got != 8459 {
		t.Fatalf("invalid configuredPort() = %d", got)
	}
}

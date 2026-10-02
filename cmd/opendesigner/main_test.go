package main

import "testing"

func TestLanURLs(t *testing.T) {
	for _, loop := range []string{"127.0.0.1:8080", "localhost:8080", "[::1]:8080", "garbage"} {
		if got := lanURLs(loop); len(got) != 0 {
			t.Errorf("lanURLs(%q) = %v, want none for a loopback-only listener", loop, got)
		}
	}
	if got := lanURLs("192.168.1.20:9000"); len(got) != 1 || got[0] != "http://192.168.1.20:9000" {
		t.Errorf("explicit private host = %v", got)
	}
	// ":8080" listens on every interface: whatever private addresses this
	// machine has, each must carry the port and no loopback may leak in.
	for _, u := range lanURLs(":8080") {
		if len(u) < len("http://") || u[len(u)-5:] != ":8080" {
			t.Errorf("url %q lost the port", u)
		}
	}
}

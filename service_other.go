//go:build !windows

package main

import "context"

// serviceContext is a no-op outside Windows: systemd and launchd stop hum with SIGTERM.
func serviceContext(ctx context.Context) context.Context { return ctx }

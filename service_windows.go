package main

import (
	"context"
	"log"

	"golang.org/x/sys/windows/svc"
)

// serviceContext lets hum run under the Windows service manager: it answers the
// SCM handshake and cancels the returned context when the service is stopped.
// Run from a console, it returns ctx unchanged.
func serviceContext(ctx context.Context) context.Context {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return ctx
	}
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		if err := svc.Run("hum", handler{cancel}); err != nil {
			log.Printf("service: %v", err)
		}
		cancel()
	}()
	return ctx
}

type handler struct{ cancel context.CancelFunc }

func (h handler) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for r := range req {
		switch r.Cmd {
		case svc.Interrogate:
			status <- r.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			h.cancel()
			return false, 0
		}
	}
	return false, 0
}

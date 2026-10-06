// hum reports a machine's vital signs to an OpenTelemetry endpoint over
// OTLP/HTTP JSON: CPU, memory, disks, network and uptime, every interval.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v4/host"
)

var version = "dev"

type config struct {
	endpoint  string
	tokenFile string
	host      string
	interval  time.Duration
	once      bool
}

func parseFlags(args []string) (config, error) {
	var c config
	fs := flag.NewFlagSet("hum", flag.ContinueOnError)
	fs.StringVar(&c.endpoint, "endpoint", envOr("HUM_ENDPOINT", ""), "OTLP/HTTP metrics URL, e.g. https://otel.example.com/v1/metrics")
	fs.StringVar(&c.tokenFile, "token-file", envOr("HUM_TOKEN_FILE", ""), "file holding the bearer token (optional)")
	fs.StringVar(&c.host, "host", envOr("HUM_HOST", ""), "host.name to report (default: OS hostname, lowercased)")
	fs.DurationVar(&c.interval, "interval", 15*time.Second, "time between reports")
	fs.BoolVar(&c.once, "once", false, "collect once, print the payload to stdout and exit")
	showVersion := fs.Bool("version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if *showVersion {
		fmt.Println(version)
		os.Exit(0)
	}
	if c.host == "" {
		h, _ := os.Hostname()
		c.host = strings.ToLower(strings.SplitN(h, ".", 2)[0])
	}
	if !c.once && c.endpoint == "" {
		return c, errors.New("-endpoint (or HUM_ENDPOINT) is required")
	}
	if c.interval < time.Second {
		return c, errors.New("-interval must be at least 1s")
	}
	return c, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetFlags(0)
	c, err := parseFlags(os.Args[1:])
	if err != nil {
		log.Fatal(err)
	}
	if c.once {
		b := snapshot(c, bootTime())
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(b.request(resourceAttrs(c)))
		return
	}
	token := ""
	if c.tokenFile != "" {
		raw, err := os.ReadFile(c.tokenFile)
		if err != nil {
			log.Fatalf("read token file: %v", err)
		}
		token = strings.TrimSpace(string(raw))
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx = serviceContext(ctx)
	run(ctx, c, token)
}

func run(ctx context.Context, c config, token string) {
	client := &http.Client{Timeout: 10 * time.Second}
	res := resourceAttrs(c)
	start := bootTime()
	log.Printf("hum %s: reporting %s to %s every %s", version, c.host, c.endpoint, c.interval)

	tick := time.NewTicker(c.interval)
	defer tick.Stop()
	failing := false
	for {
		err := send(ctx, client, c.endpoint, token, snapshot(c, start).request(res))
		switch {
		case err != nil && !failing:
			log.Printf("export failing: %v", err)
			failing = true
		case err == nil && failing:
			log.Printf("export recovered")
			failing = false
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func snapshot(c config, start time.Time) *batch {
	b := &batch{host: c.host, now: time.Now(), start: start}
	collect(b)
	return b
}

func resourceAttrs(c config) []keyValue {
	return []keyValue{
		str("service.name", "hum"),
		str("service.version", version),
		str("host.name", c.host),
		str("host.arch", runtime.GOARCH),
		str("os.type", runtime.GOOS),
	}
}

// bootTime is the start time of the cumulative network counters.
func bootTime() time.Time {
	if bt, err := host.BootTime(); err == nil {
		return time.Unix(int64(bt), 0)
	}
	return time.Now()
}

func send(ctx context.Context, client *http.Client, endpoint, token string, body exportRequest) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "hum/"+version)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

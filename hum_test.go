package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSnapshotShape(t *testing.T) {
	c := config{host: "box"}
	b := snapshot(c, time.Unix(1, 0))
	raw, err := json.Marshal(b.request(resourceAttrs(c)))
	if err != nil {
		t.Fatal(err)
	}
	var req struct {
		ResourceMetrics []struct {
			ScopeMetrics []struct {
				Metrics []struct {
					Name  string
					Gauge *struct{ DataPoints []map[string]any }
					Sum   *struct {
						AggregationTemporality int
						DataPoints             []map[string]any
					}
				}
			}
		}
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, m := range req.ResourceMetrics[0].ScopeMetrics[0].Metrics {
		names[m.Name] = true
		var dps []map[string]any
		if m.Gauge != nil {
			dps = m.Gauge.DataPoints
		} else {
			if m.Sum.AggregationTemporality != temporalityCumulative {
				t.Errorf("%s: temporality %d", m.Name, m.Sum.AggregationTemporality)
			}
			dps = m.Sum.DataPoints
			if _, ok := dps[0]["asInt"].(string); !ok {
				t.Errorf("%s: asInt must be a JSON string", m.Name)
			}
		}
		if !strings.Contains(string(mustJSON(t, dps[0]["attributes"])), `"host.name"`) {
			t.Errorf("%s: point lacks host.name", m.Name)
		}
	}
	for _, want := range []string{"system.cpu.utilization", "system.memory.utilization", "system.uptime", "system.network.io"} {
		if !names[want] {
			t.Errorf("missing %s", want)
		}
	}
}

func TestSendAuthAndErrors(t *testing.T) {
	var gotAuth, gotType string
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotType = r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		_, _ = io.ReadAll(r.Body)
		w.WriteHeader(status)
		_, _ = w.Write([]byte("nope"))
	}))
	defer srv.Close()

	body := (&batch{host: "box", now: time.Now()}).request(nil)
	if err := send(context.Background(), srv.Client(), srv.URL, "sk_x", body); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer sk_x" || gotType != "application/json" {
		t.Fatalf("headers: %q %q", gotAuth, gotType)
	}
	status = http.StatusUnauthorized
	err := send(context.Background(), srv.Client(), srv.URL, "sk_x", body)
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want 401 error, got %v", err)
	}
}

func TestParseFlags(t *testing.T) {
	if _, err := parseFlags(nil); err == nil {
		t.Error("missing endpoint should fail")
	}
	c, err := parseFlags([]string{"-endpoint", "http://x/v1/metrics", "-host", "Mini"})
	if err != nil || c.host != "Mini" || c.interval != 15*time.Second {
		t.Errorf("got %+v, %v", c, err)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

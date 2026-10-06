package main

import (
	"strconv"
	"time"
)

// The structs below are the subset of OTLP/HTTP JSON that hum emits.
// Field names follow the proto3 JSON mapping (lowerCamelCase, int64 as string).

type anyValue struct {
	StringValue *string `json:"stringValue,omitempty"`
}

type keyValue struct {
	Key   string   `json:"key"`
	Value anyValue `json:"value"`
}

type dataPoint struct {
	StartTimeUnixNano string     `json:"startTimeUnixNano,omitempty"`
	TimeUnixNano      string     `json:"timeUnixNano"`
	AsDouble          *float64   `json:"asDouble,omitempty"`
	AsInt             string     `json:"asInt,omitempty"`
	Attributes        []keyValue `json:"attributes,omitempty"`
}

type gauge struct {
	DataPoints []dataPoint `json:"dataPoints"`
}

type sum struct {
	DataPoints             []dataPoint `json:"dataPoints"`
	AggregationTemporality int         `json:"aggregationTemporality"`
	IsMonotonic            bool        `json:"isMonotonic"`
}

type metric struct {
	Name  string `json:"name"`
	Unit  string `json:"unit,omitempty"`
	Gauge *gauge `json:"gauge,omitempty"`
	Sum   *sum   `json:"sum,omitempty"`
}

type scope struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type scopeMetrics struct {
	Scope   scope    `json:"scope"`
	Metrics []metric `json:"metrics"`
}

type resource struct {
	Attributes []keyValue `json:"attributes"`
}

type resourceMetrics struct {
	Resource     resource       `json:"resource"`
	ScopeMetrics []scopeMetrics `json:"scopeMetrics"`
}

type exportRequest struct {
	ResourceMetrics []resourceMetrics `json:"resourceMetrics"`
}

const temporalityCumulative = 2

func str(k, v string) keyValue {
	return keyValue{Key: k, Value: anyValue{StringValue: &v}}
}

func nanos(t time.Time) string {
	return strconv.FormatInt(t.UnixNano(), 10)
}

// batch collects the metrics of one tick. Every point carries host.name in its
// own attributes, because sensorium's query_metrics returns point attributes
// but not the resource.
type batch struct {
	host    string
	now     time.Time
	start   time.Time
	metrics []metric
}

func (b *batch) attrs(extra ...keyValue) []keyValue {
	return append([]keyValue{str("host.name", b.host)}, extra...)
}

func (b *batch) gauge(name, unit string, v float64, extra ...keyValue) {
	b.metrics = append(b.metrics, metric{Name: name, Unit: unit, Gauge: &gauge{DataPoints: []dataPoint{
		{TimeUnixNano: nanos(b.now), AsDouble: &v, Attributes: b.attrs(extra...)},
	}}})
}

func (b *batch) counter(name, unit string, v uint64, extra ...keyValue) {
	b.metrics = append(b.metrics, metric{Name: name, Unit: unit, Sum: &sum{
		AggregationTemporality: temporalityCumulative,
		IsMonotonic:            true,
		DataPoints: []dataPoint{{
			StartTimeUnixNano: nanos(b.start),
			TimeUnixNano:      nanos(b.now),
			AsInt:             strconv.FormatUint(v, 10),
			Attributes:        b.attrs(extra...),
		}},
	}})
}

func (b *batch) request(res []keyValue) exportRequest {
	return exportRequest{ResourceMetrics: []resourceMetrics{{
		Resource: resource{Attributes: res},
		ScopeMetrics: []scopeMetrics{{
			Scope:   scope{Name: "hum", Version: version},
			Metrics: b.metrics,
		}},
	}}}
}

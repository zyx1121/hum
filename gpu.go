package main

import (
	"context"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const mib = 1 << 20

// gpu is one reading of one GPU. limit is 0 when the device has no dedicated memory size to report.
type gpu struct {
	id, name, vendor string
	util             float64 // 0..1
	used, limit      float64 // bytes
}

// collectGPU reports every GPU hum can read without drivers of its own:
// NVIDIA through nvidia-smi, Apple silicon through ioreg. Hosts with neither report nothing.
func collectGPU(b *batch) {
	var gpus []gpu
	if path, err := exec.LookPath("nvidia-smi"); err == nil {
		gpus = append(gpus, nvidiaGPUs(path)...)
	}
	if runtime.GOOS == "darwin" {
		gpus = append(gpus, appleGPUs()...)
	}
	for _, g := range gpus {
		at := []keyValue{str("hw.id", g.id), str("hw.name", g.name), str("hw.vendor", g.vendor)}
		b.gauge("hw.gpu.utilization", "1", g.util, at...)
		b.gauge("hw.gpu.memory.usage", "By", g.used, at...)
		if g.limit > 0 {
			b.gauge("hw.gpu.memory.limit", "By", g.limit, at...)
		}
	}
}

func output(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return string(out), err
}

func nvidiaGPUs(path string) []gpu {
	out, err := output(path, "--query-gpu=index,name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits")
	if err != nil {
		return nil
	}
	return parseNvidia(out)
}

func parseNvidia(out string) []gpu {
	var gpus []gpu
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Split(line, ",")
		if len(f) != 5 {
			continue
		}
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		util, err1 := strconv.ParseFloat(f[2], 64)
		used, err2 := strconv.ParseFloat(f[3], 64)
		total, err3 := strconv.ParseFloat(f[4], 64)
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		gpus = append(gpus, gpu{id: "gpu" + f[0], name: f[1], vendor: "nvidia", util: util / 100, used: used * mib, limit: total * mib})
	}
	return gpus
}

var (
	ioregUtil = regexp.MustCompile(`"Device Utilization %"=(\d+)`)
	ioregMem  = regexp.MustCompile(`"In use system memory"=(\d+)`)
)

func appleGPUs() []gpu {
	out, err := output("/usr/sbin/ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator")
	if err != nil {
		return nil
	}
	return parseIoreg(out)
}

// parseIoreg reads Apple silicon's GPU statistics. Its memory is unified, so there is no limit to report.
func parseIoreg(out string) []gpu {
	u := ioregUtil.FindStringSubmatch(out)
	if u == nil {
		return nil
	}
	util, _ := strconv.ParseFloat(u[1], 64)
	g := gpu{id: "gpu0", name: "Apple GPU", vendor: "apple", util: util / 100}
	if m := ioregMem.FindStringSubmatch(out); m != nil {
		g.used, _ = strconv.ParseFloat(m[1], 64)
	}
	return []gpu{g}
}

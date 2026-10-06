package main

import (
	"runtime"
	"strings"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

// collect reads one snapshot of the host. A reader that fails is skipped, so a
// single broken source never drops the whole tick.
func collect(b *batch) {
	// Percent(0) compares against the previous call, so the first tick reads 0.
	if p, err := cpu.Percent(0, false); err == nil && len(p) == 1 {
		b.gauge("system.cpu.utilization", "1", p[0]/100)
	}
	if n, err := cpu.Counts(true); err == nil {
		b.gauge("system.cpu.logical.count", "{cpu}", float64(n))
	}
	if runtime.GOOS != "windows" {
		if l, err := load.Avg(); err == nil {
			b.gauge("system.cpu.load_average.1m", "{thread}", l.Load1)
		}
	}

	if m, err := mem.VirtualMemory(); err == nil {
		b.gauge("system.memory.limit", "By", float64(m.Total))
		b.gauge("system.memory.usage", "By", float64(m.Used), str("system.memory.state", "used"))
		b.gauge("system.memory.utilization", "1", m.UsedPercent/100)
	}

	for _, mp := range mountpoints() {
		u, err := disk.Usage(mp)
		if err != nil || u.Total == 0 {
			continue
		}
		at := str("system.filesystem.mountpoint", mp)
		b.gauge("system.filesystem.limit", "By", float64(u.Total), at)
		b.gauge("system.filesystem.utilization", "1", u.UsedPercent/100, at)
	}

	if io, err := net.IOCounters(false); err == nil && len(io) == 1 {
		b.counter("system.network.io", "By", io[0].BytesRecv, str("network.io.direction", "receive"))
		b.counter("system.network.io", "By", io[0].BytesSent, str("network.io.direction", "transmit"))
	}

	if up, err := host.Uptime(); err == nil {
		b.gauge("system.uptime", "s", float64(up))
	}
}

// mountpoints returns the filesystems worth reporting: fixed local disks only.
func mountpoints() []string {
	if runtime.GOOS == "darwin" {
		// "/" is the sealed system volume; user data lives on the Data volume.
		return []string{"/System/Volumes/Data"}
	}
	parts, err := disk.Partitions(false)
	if err != nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, p := range parts {
		if seen[p.Mountpoint] || skipFS(p) {
			continue
		}
		seen[p.Mountpoint] = true
		out = append(out, p.Mountpoint)
	}
	return out
}

func skipFS(p disk.PartitionStat) bool {
	switch p.Fstype {
	case "tmpfs", "devtmpfs", "overlay", "squashfs", "nsfs", "fuse.lxcfs", "efivarfs", "vfat":
		return true
	}
	for _, prefix := range []string{"/boot", "/snap", "/run", "/dev", "/sys", "/proc", "/var/lib/docker"} {
		if strings.HasPrefix(p.Mountpoint, prefix) {
			return true
		}
	}
	return false
}

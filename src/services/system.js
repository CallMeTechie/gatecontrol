'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);

// CPU usage is a delta between two samples of os.cpus() times. Each consumer
// keeps its OWN previous sample: /metrics (Prometheus scrape) and the
// dashboard's /system/resources used to share one, so each call measured
// only the time since the other caller's last call — and the very first call
// had no sample at all and reported 0.
const prevCpuInfo = new Map(); // consumer → { idle, total, at }
const MIN_SAMPLE_MS = 250;     // shortest window that still gives a stable value

function cpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle: id, irq } = cpu.times;
    total += user + nice + sys + id + irq;
    idle += id;
  }
  return { cpus, idle, total };
}

function percentBetween(prev, cur) {
  const idleDiff = cur.idle - prev.idle;
  const totalDiff = cur.total - prev.total;
  return totalDiff > 0 ? Math.min(100, Math.max(0, Math.round((1 - idleDiff / totalDiff) * 100))) : 0;
}

function cpuResult(cpus, percent) {
  return {
    percent,
    cores: cpus.length,
    model: cpus[0] ? cpus[0].model.trim() : 'Unknown',
  };
}

/**
 * CPU usage since `consumer`'s previous call (synchronous; 0 on its first
 * call). Kept for /metrics, which is scraped at a steady interval.
 */
function getCpuUsage(consumer = 'metrics') {
  const cur = cpuTimes();
  const prev = prevCpuInfo.get(consumer);
  const percent = prev ? percentBetween(prev, cur) : 0;
  prevCpuInfo.set(consumer, { idle: cur.idle, total: cur.total, at: Date.now() });
  return cpuResult(cur.cpus, percent);
}

/**
 * CPU usage for on-demand readers (dashboard): measured against this
 * consumer's previous sample, or — on the first call, or when that sample is
 * younger than MIN_SAMPLE_MS — over a short fresh window, so it never
 * reports a meaningless 0.
 */
async function sampleCpuUsage(consumer = 'resources', { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let prev = prevCpuInfo.get(consumer);
  if (!prev || Date.now() - prev.at < MIN_SAMPLE_MS) {
    const first = cpuTimes();
    prev = { idle: first.idle, total: first.total, at: Date.now() };
    await sleep(MIN_SAMPLE_MS);
  }
  const cur = cpuTimes();
  prevCpuInfo.set(consumer, { idle: cur.idle, total: cur.total, at: Date.now() });
  return cpuResult(cur.cpus, percentBetween(prev, cur));
}

/**
 * Get RAM usage
 */
function getMemoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percent = Math.round((used / total) * 100);

  return {
    total,
    free,
    used,
    percent,
  };
}

/**
 * Get system uptime
 */
function getUptime() {
  const uptimeSec = os.uptime();
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);

  return {
    seconds: uptimeSec,
    formatted: days > 0
      ? `${days}d ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
      : `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    bootTime: new Date(Date.now() - uptimeSec * 1000).toISOString().split('T')[0],
  };
}

/**
 * Get disk usage for root partition
 */
async function getDiskUsage() {
  try {
    const { stdout } = await exec('df', ['-B1', '/'], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return null;

    const parts = lines[1].split(/\s+/);
    const total = parseInt(parts[1], 10);
    const used = parseInt(parts[2], 10);
    const percent = Math.round((used / total) * 100);

    return { total, used, available: total - used, percent };
  } catch {
    return null;
  }
}

/**
 * Get all system resources
 */
async function getResources({ consumer = 'resources' } = {}) {
  const cpu = await sampleCpuUsage(consumer);
  const memory = getMemoryUsage();
  const uptime = getUptime();
  const disk = await getDiskUsage();

  return { cpu, memory, uptime, disk };
}

module.exports = {
  getCpuUsage,
  sampleCpuUsage,
  MIN_SAMPLE_MS,
  getMemoryUsage,
  getUptime,
  getDiskUsage,
  getResources,
};

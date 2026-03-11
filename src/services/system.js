'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);

let prevCpuInfo = null;

/**
 * Calculate CPU usage between two snapshots
 */
function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalTick += user + nice + sys + idle + irq;
    totalIdle += idle;
  }

  let usagePercent = 0;

  if (prevCpuInfo) {
    const idleDiff = totalIdle - prevCpuInfo.idle;
    const totalDiff = totalTick - prevCpuInfo.total;
    usagePercent = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
  }

  prevCpuInfo = { idle: totalIdle, total: totalTick };

  return {
    percent: usagePercent,
    cores: cpus.length,
    model: cpus[0] ? cpus[0].model.trim() : 'Unknown',
  };
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
async function getResources() {
  const cpu = getCpuUsage();
  const memory = getMemoryUsage();
  const uptime = getUptime();
  const disk = await getDiskUsage();

  return { cpu, memory, uptime, disk };
}

module.exports = {
  getCpuUsage,
  getMemoryUsage,
  getUptime,
  getDiskUsage,
  getResources,
};

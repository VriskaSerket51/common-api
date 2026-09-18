import scheduler from "node-schedule";
import { logger } from "../logger/index.js";

export interface Schedule {
  name: string;
  cron: string;
  job: () => void | Promise<void>;
}

const jobs = new Map<string, scheduler.Job>();
const running = new Set<Promise<void>>();
let stopping: Promise<void> | undefined;

export const initializeScheduler = (schedules: readonly Schedule[]): scheduler.Job[] => {
  if (stopping) throw new Error("The scheduler is shutting down.");
  const names = new Set([...jobs.keys(), ...Object.keys(scheduler.scheduledJobs)]);
  for (const schedule of schedules) {
    if (!schedule.name.trim() || names.has(schedule.name)) {
      throw new Error("Schedule names must be non-empty and unique: " + schedule.name);
    }
    names.add(schedule.name);
  }
  const created: scheduler.Job[] = [];
  try {
    for (const schedule of schedules) {
      const job = scheduler.scheduleJob(schedule.name, schedule.cron, async (fireDate) => {
        const now = new Date();
        if (now.getTime() - fireDate.getTime() >= 1000) {
          logger.info(schedule.name + " was supposed to run at " + fireDate.toISOString()
            + ", but actually ran at " + now.toISOString());
        }
        const execution = Promise.resolve().then(() => schedule.job());
        running.add(execution);
        try { await execution; } finally { running.delete(execution); }
      });
      if (!job) throw new Error("Invalid cron expression for schedule: " + schedule.name);
      job.on("error", (error: unknown) => {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        logger.error("Scheduled job failed: " + schedule.name + ": " + detail);
      });
      jobs.set(schedule.name, job);
      created.push(job);
    }
    return created;
  } catch (error) {
    for (const job of created) {
      job.cancel();
      jobs.delete(job.name);
    }
    throw error;
  }
};

export const shutdownScheduler = (): Promise<void> => {
  if (stopping) return stopping;
  for (const job of jobs.values()) job.cancel();
  jobs.clear();
  stopping = Promise.allSettled([...running]).then(() => {}).finally(() => { stopping = undefined; });
  return stopping;
};

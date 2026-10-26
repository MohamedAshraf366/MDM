import type { AppDatabase } from './database';
import type { DownloadManager } from './manager';
import type { AppLogger } from './logger';
import type { ScheduleRecord } from '../shared/types';
import { scheduleOccurrences } from '../shared/validation';

const TICK_INTERVAL_MS = 10_000;
const CATCH_UP_MS = 2 * 60_000;

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private lastCheck = new Date(Date.now() - CATCH_UP_MS);

  constructor(
    private readonly db: AppDatabase,
    private readonly manager: DownloadManager,
    private readonly logger: AppLogger
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastCheck = new Date(Date.now() - CATCH_UP_MS);
    this.tick().catch((error) => this.logger.error('scheduler', `Scheduler failed: ${(error as Error).message}`));
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error('scheduler', `Scheduler failed: ${(error as Error).message}`));
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const windowStart = new Date(Math.max(this.lastCheck.getTime(), now.getTime() - CATCH_UP_MS) - 1000);
      const schedules = this.db.listSchedules();
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        const due = scheduleOccurrences(schedule, windowStart)
          .filter((occurrence) => occurrence.at.getTime() <= now.getTime())
          .filter((occurrence) => occurrence.key !== schedule.lastFiredKey);
        if (!due.length) continue;
        const occurrence = due[due.length - 1]!;
        this.fire(schedule, occurrence.action, occurrence.key);
      }
      this.lastCheck = now;
    } finally {
      this.checking = false;
    }
  }

  private fire(schedule: ScheduleRecord, action: ScheduleRecord['action'], key: string): void {
    try {
      this.manager.dispatchScheduleAction(action, schedule.queueId);
      this.db.updateSchedule({ ...schedule, lastFiredKey: key, updatedAt: new Date().toISOString() });
      this.logger.info('scheduler', `Ran schedule "${schedule.name}" (${action}).`);
    } catch (error) {
      this.logger.error('scheduler', `Schedule "${schedule.name}" could not run: ${(error as Error).message}`);
    }
  }
}

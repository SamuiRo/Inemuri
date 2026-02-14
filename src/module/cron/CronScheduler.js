import cron from "node-cron";
import { print } from "../../shared/utils.js";

/**
 * CronScheduler manages scheduled tasks that generate messages
 * These messages are emitted to the EventBus as message.received events
 */
export default class CronScheduler {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.jobs = new Map();
    this.isInitialized = false;
  }

  /**
   * Initialize scheduler with job configurations
   * @param {Array} jobConfigs - Array of job configuration objects
   */
  async initialize(jobConfigs = []) {
    if (this.isInitialized) {
      print("CronScheduler already initialized", "warning");
      return;
    }

    print(`Initializing CronScheduler with ${jobConfigs.length} jobs`);

    for (const config of jobConfigs) {
      this.scheduleJob(config);
    }

    this.isInitialized = true;
    print("CronScheduler initialized successfully");
  }

  /**
   * Schedule a new cron job
   * @param {Object} config - Job configuration
   * @param {string} config.id - Unique job identifier
   * @param {string} config.schedule - Cron schedule expression
   * @param {Function} config.handler - Async function that generates message data
   * @param {string} config.description - Job description for logging
   * @param {boolean} config.enabled - Whether job is enabled
   */
  scheduleJob(config) {
    const { id, schedule, handler, description, enabled = true } = config;

    if (!enabled) {
      print(`Skipping disabled cron job: ${id}`);
      return;
    }

    if (this.jobs.has(id)) {
      print(`Cron job ${id} already exists, skipping`, "warning");
      return;
    }

    // Validate cron expression
    if (!cron.validate(schedule)) {
      print(`Invalid cron schedule for job ${id}: ${schedule}`, "error");
      return;
    }

    const task = cron.schedule(schedule, async () => {
      try {
        print(`Executing cron job: ${id} - ${description}`);

        // Execute the handler to get message data
        const messageData = await handler();

        if (!messageData) {
          print(`Cron job ${id} returned no message data`, "warning");
          return;
        }

        // Emit as message.received event
        // This makes cronjobs work like any other message source
        this.eventBus.emitMessageReceived({
          ...messageData,
          metadata: {
            ...messageData.metadata,
            source: "cron",
            cronJobId: id,
            timestamp: new Date().toISOString(),
          },
        });

        print(`Cron job ${id} message emitted successfully`);
      } catch (error) {
        print(`Error executing cron job ${id}: ${error.message}`, "error");
        console.error(error);
        this.eventBus.emitError({
          error,
          context: `CronJob: ${id}`,
          cronJobId: id,
        });
      }
    });

    this.jobs.set(id, {
      task,
      config,
      lastRun: null,
    });

    print(`Scheduled cron job: ${id} (${schedule}) - ${description}`);
  }

  /**
   * Stop a specific job
   */
  stopJob(id) {
    const job = this.jobs.get(id);
    if (!job) {
      print(`Cron job ${id} not found`, "warning");
      return false;
    }

    job.task.stop();
    this.jobs.delete(id);
    print(`Stopped cron job: ${id}`);
    return true;
  }

  /**
   * Stop all scheduled jobs
   */
  async stop() {
    print("Shutting down CronScheduler");

    for (const [id, job] of this.jobs.entries()) {
      job.task.stop();
      print(`Stopped cron job: ${id}`);
    }

    this.jobs.clear();
    this.isInitialized = false;
    print("CronScheduler shutdown complete");
  }

  /**
   * Get status of all jobs
   */
  getStatus() {
    const jobs = Array.from(this.jobs.entries()).map(([id, job]) => ({
      id,
      schedule: job.config.schedule,
      description: job.config.description,
      enabled: job.config.enabled,
      lastRun: job.lastRun,
    }));

    return {
      initialized: this.isInitialized,
      totalJobs: this.jobs.size,
      jobs,
    };
  }
}

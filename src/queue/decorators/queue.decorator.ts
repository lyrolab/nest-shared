import { DiscoveryService } from "@nestjs/core"

export type JobProcessorMetadata = {
  /**
   * The name of the job.
   */
  name: string

  /**
   * If the job should be processed on a schedule, configure the cron expression.
   * @example "0 0 * * *"
   */
  cron?: string
}

export const JobProcessor = DiscoveryService.createDecorator<
  string | JobProcessorMetadata
>()

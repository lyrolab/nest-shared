import { Job } from "bullmq"

export type JobProcessorInterface = {
  process: (job: Job, token?: string) => Promise<void>
}

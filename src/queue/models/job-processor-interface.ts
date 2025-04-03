import { Job } from "bullmq"

export type JobProcessorInterface = {
  process: (job: Job) => Promise<void>
}

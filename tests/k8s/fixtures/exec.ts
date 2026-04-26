import { execFile, type ExecFileOptions } from "node:child_process"
import { Data, Effect } from "effect"

export class ExecError extends Data.TaggedError("ExecError")<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly cause?: unknown
}> {
  override get message(): string {
    const head = `exec failed: ${this.command} ${this.args.join(" ")} (exit=${this.exitCode}, signal=${this.signal})`
    const tail = this.stderr.trim() || this.stdout.trim()
    return tail ? `${head}\n${tail}` : head
  }
}

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
}

export interface ExecOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
  readonly maxBufferBytes?: number
}

export const exec = (
  command: string,
  args: ReadonlyArray<string>,
  options: ExecOptions = {},
): Effect.Effect<ExecResult, ExecError> =>
  Effect.callback<ExecResult, ExecError>((resume) => {
    const opts: ExecFileOptions = {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
    }
    execFile(command, args as Array<string>, opts, (err, stdout, stderr) => {
      const stdoutStr = typeof stdout === "string" ? stdout : stdout.toString("utf8")
      const stderrStr = typeof stderr === "string" ? stderr : stderr.toString("utf8")
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string }
        resume(
          Effect.fail(
            new ExecError({
              command,
              args,
              exitCode: typeof e.code === "number" ? e.code : null,
              signal: (e as { signal?: NodeJS.Signals }).signal ?? null,
              stdout: stdoutStr,
              stderr: stderrStr,
              cause: err,
            }),
          ),
        )
        return
      }
      resume(Effect.succeed({ stdout: stdoutStr, stderr: stderrStr }))
    })
  })

import PromiseQueue from 'next/dist/compiled/p-queue'
import type { RequestLifecycleOpts } from '../base-server'
import type { AfterCallback, AfterTask } from './after'
import { InvariantError } from '../../shared/lib/invariant-error'
import { isThenable } from '../../shared/lib/is-thenable'
import { workAsyncStorage } from '../app-render/work-async-storage.external'
import { withExecuteRevalidates } from './revalidation-utils'
import { bindSnapshot } from '../app-render/async-local-storage'
import {
  workUnitAsyncStorage,
  type WorkUnitStore,
} from '../app-render/work-unit-async-storage.external'
import { afterTaskAsyncStorage } from '../app-render/after-task-async-storage.external'
import isError from '../../lib/is-error'
import {
  AFTER_CALLBACK_TOP_FRAME,
  patchAfterCallstackInDev,
  type OriginalStacks,
} from './after-dev-callstacks'
import {
  HMR_ACTIONS_SENT_TO_BROWSER,
  type NextJsHotReloaderInterface,
} from '../dev/hot-reloader-types'
import { stringifyError } from '../../shared/lib/utils'

export type AfterContextOpts = {
  isEnabled: boolean
  waitUntil: RequestLifecycleOpts['waitUntil'] | undefined
  onClose: RequestLifecycleOpts['onClose']
  onTaskError: RequestLifecycleOpts['onAfterTaskError'] | undefined
}

export class AfterContext {
  private waitUntil: RequestLifecycleOpts['waitUntil'] | undefined
  private onClose: RequestLifecycleOpts['onClose']
  private onTaskError: RequestLifecycleOpts['onAfterTaskError'] | undefined
  public readonly isEnabled: boolean

  private runCallbacksOnClosePromise: Promise<void> | undefined
  private callbackQueue: PromiseQueue
  private workUnitStores = new Set<WorkUnitStore>()

  constructor({
    waitUntil,
    onClose,
    onTaskError,
    isEnabled,
  }: AfterContextOpts) {
    this.waitUntil = waitUntil
    this.onClose = onClose
    this.onTaskError = onTaskError
    this.isEnabled = isEnabled

    this.callbackQueue = new PromiseQueue()
    this.callbackQueue.pause()
  }

  public after(task: AfterTask, originalStack: string | undefined): void {
    if (isThenable(task)) {
      if (!this.waitUntil) {
        errorWaitUntilNotAvailable()
      }
      this.waitUntil(
        task.catch((error) => this.reportTaskError('promise', error, undefined))
      )
    } else if (typeof task === 'function') {
      // TODO(after): implement tracing
      this.addCallback(task, originalStack)
    } else {
      throw new Error(
        '`unstable_after()`: Argument must be a promise or a function'
      )
    }
  }

  private addCallback(
    callback: AfterCallback,
    originalStack: string | undefined
  ) {
    // if something is wrong, throw synchronously, bubbling up to the `unstable_after` callsite.
    if (!this.waitUntil) {
      errorWaitUntilNotAvailable()
    }

    const workUnitStore = workUnitAsyncStorage.getStore()
    if (workUnitStore) {
      this.workUnitStores.add(workUnitStore)
    }

    const afterTaskStore = afterTaskAsyncStorage.getStore()

    // This is used for checking if request APIs can be called inside `after`.
    // Note that we need to check the phase in which the *topmost* `after` was called (which should be "action"),
    // not the current phase (which might be "after" if we're in a nested after).
    // Otherwise, we might allow `after(() => headers())`, but not `after(() => after(() => headers()))`.
    const rootTaskSpawnPhase = afterTaskStore
      ? afterTaskStore.rootTaskSpawnPhase // nested after
      : workUnitStore?.phase // topmost after

    // this should only happen once.
    if (!this.runCallbacksOnClosePromise) {
      this.runCallbacksOnClosePromise = this.runCallbacksOnClose()
      this.waitUntil(this.runCallbacksOnClosePromise)
    }

    // Bind the callback to the current execution context (i.e. preserve all currently available ALS-es).
    // We do this because we want all of these to be equivalent in every regard except timing:
    //   after(() => x())
    //   after(x())
    //   await x()

    let originalStacks: OriginalStacks | undefined
    if (process.env.NODE_ENV === 'development') {
      originalStacks = [
        originalStack,
        ...(afterTaskStore?.originalStacks ?? []),
      ]
    }

    const unwrappedCallback = {
      [AFTER_CALLBACK_TOP_FRAME]: async () => {
        try {
          await afterTaskAsyncStorage.run(
            {
              rootTaskSpawnPhase,
              originalStacks,
            },
            () => callback()
          )
        } catch (error) {
          this.reportTaskError('function', error, originalStacks)
        }
      },
    }[AFTER_CALLBACK_TOP_FRAME]

    const wrappedCallback = bindSnapshot(unwrappedCallback)

    this.callbackQueue.add(wrappedCallback)
  }

  private async runCallbacksOnClose() {
    await new Promise<void>((resolve) => this.onClose!(resolve))
    return this.runCallbacks()
  }

  private async runCallbacks(): Promise<void> {
    if (this.callbackQueue.size === 0) return

    for (const workUnitStore of this.workUnitStores) {
      workUnitStore.phase = 'after'
    }

    const workStore = workAsyncStorage.getStore()
    if (!workStore) {
      throw new InvariantError('Missing workStore in AfterContext.runCallbacks')
    }

    return withExecuteRevalidates(workStore, () => {
      this.callbackQueue.start()
      return this.callbackQueue.onIdle()
    })
  }

  private reportTaskError(
    taskKind: 'promise' | 'function',
    error: unknown,
    originalStacks: OriginalStacks | undefined
  ) {
    // TODO(after): this is fine for now, but will need better intergration with our error reporting.
    // TODO(after): should we log this if we have a onTaskError callback?
    console.error(
      taskKind === 'promise'
        ? `A promise passed to \`unstable_after()\` rejected:`
        : `An error occurred in a function passed to \`unstable_after()\`:`,
      error
    )

    if (process.env.NODE_ENV === 'development') {
      if (isError(error) && originalStacks) {
        try {
          error = patchAfterCallstackInDev(error, originalStacks)
        } catch (patchError) {
          // if something goes wrong here, we just want to log it
          console.error(
            new InvariantError('Could not patch callstack for after callback', {
              cause: patchError,
            })
          )
        }
      }

      reportAfterErrorInDev(error)
    }

    if (this.onTaskError) {
      // this is very defensive, but we really don't want anything to blow up in an error handler
      try {
        this.onTaskError?.(error)
      } catch (handlerError) {
        console.error(
          new InvariantError(
            '`onTaskError` threw while handling an error thrown from an `unstable_after` task',
            {
              cause: handlerError,
            }
          )
        )
      }
    }
  }
}

function reportAfterErrorInDev(error: unknown) {
  // TODO: we probably want to inject this as `onAfterTaskError` from NextDevServer,
  // where we have access to `bundlerService` (which has the hotReloader)
  const hotReloader: NextJsHotReloaderInterface | undefined =
    // @ts-expect-error
    globalThis[Symbol.for('@next/dev/hot-reloader')]

  hotReloader?.send({
    action: HMR_ACTIONS_SENT_TO_BROWSER.AFTER_ERROR,
    source: process.env.NEXT_RUNTIME === 'edge' ? 'edge-server' : 'server',
    errorJSON: isError(error)
      ? stringifyError(error)
      : (() => {
          try {
            return JSON.stringify(error)
          } catch (_) {
            return '<unknown>'
          }
        })(),
  })
}

function errorWaitUntilNotAvailable(): never {
  throw new Error(
    '`unstable_after()` will not work correctly, because `waitUntil` is not available in the current environment.'
  )
}

/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable no-console */

import type { Source } from 'wonka';
import { pipe, subscribe, onEnd, onPush, takeWhile } from 'wonka';
import * as React from 'react';

import type {
  GraphQLRequestParams,
  AnyVariables,
  Client,
  CombinedError,
  OperationContext,
  RequestPolicy,
  OperationResult,
  Operation,
} from '@urql/core';

import { useClient } from '../context';
import { useRequest } from './useRequest';
import { getCacheForClient } from './cache';

import {
  deferDispatch,
  initialState,
  computeNextState,
  hasDepsChanged,
} from './state';

/** Input arguments for the {@link useQuery} hook.
 *
 * @param query - The GraphQL query that `useQuery` executes.
 * @param variables - The variables for the GraphQL query that `useQuery` executes.
 */
export type UseQueryArgs<
  Variables extends AnyVariables = AnyVariables,
  Data = any,
> = {
  /** Updates the {@link RequestPolicy} for the executed GraphQL query operation.
   *
   * @remarks
   * `requestPolicy` modifies the {@link RequestPolicy} of the GraphQL query operation
   * that `useQuery` executes, and indicates a caching strategy for cache exchanges.
   *
   * For example, when set to `'cache-and-network'`, {@link useQuery} will
   * receive a cached result with `stale: true` and an API request will be
   * sent in the background.
   *
   * @see {@link OperationContext.requestPolicy} for where this value is set.
   */
  requestPolicy?: RequestPolicy;
  /** Updates the {@link OperationContext} for the executed GraphQL query operation.
   *
   * @remarks
   * `context` may be passed to {@link useQuery}, to update the {@link OperationContext}
   * of a query operation. This may be used to update the `context` that exchanges
   * will receive for a single hook.
   *
   * Hint: This should be wrapped in a `useMemo` hook, to make sure that your
   * component doesn’t infinitely update.
   *
   * @example
   * ```ts
   * const [result, reexecute] = useQuery({
   *   query,
   *   context: useMemo(() => ({
   *     additionalTypenames: ['Item'],
   *   }), [])
   * });
   * ```
   */
  context?: Partial<OperationContext>;
  /** Prevents {@link useQuery} from automatically executing GraphQL query operations.
   *
   * @remarks
   * `pause` may be set to `true` to stop {@link useQuery} from executing
   * automatically. The hook will stop receiving updates from the {@link Client}
   * and won't execute the query operation, until either it's set to `false`
   * or the {@link UseQueryExecute} function is called.
   *
   * @see {@link https://urql.dev/goto/docs/basics/react-preact/#pausing-usequery} for
   * documentation on the `pause` option.
   */
  pause?: boolean;
  /** Enables verbose console logging for debugging suspense issues.
   *
   * @remarks
   * When set to `true`, `useQuery` will output detailed console logs
   * about its internal state transitions, cache operations, and suspense behavior.
   * This is useful for debugging issues related to suspense and cache interactions.
   *
   * @defaultValue false
   */
  debug?: boolean;
} & GraphQLRequestParams<Data, Variables>;

/** State of the current query, your {@link useQuery} hook is executing.
 *
 * @remarks
 * `UseQueryState` is returned (in a tuple) by {@link useQuery} and
 * gives you the updating {@link OperationResult} of GraphQL queries.
 *
 * Even when the query and variables passed to {@link useQuery} change,
 * this state preserves the prior state and sets the `fetching` flag to
 * `true`.
 * This allows you to display the previous state, while implementing
 * a separate loading indicator separately.
 */
export interface UseQueryState<
  Data = any,
  Variables extends AnyVariables = AnyVariables,
> {
  /** Indicates whether `useQuery` is waiting for a new result.
   *
   * @remarks
   * When `useQuery` is passed a new query and/or variables, it will
   * start executing the new query operation and `fetching` is set to
   * `true` until a result arrives.
   *
   * Hint: This is subtly different than whether the query is actually
   * fetching, and doesn’t indicate whether a query is being re-executed
   * in the background. For this, see {@link UseQueryState.stale}.
   */
  fetching: boolean;
  /** Indicates that the state is not fresh and a new result will follow.
   *
   * @remarks
   * The `stale` flag is set to `true` when a new result for the query
   * is expected and `useQuery` is waiting for it. This may indicate that
   * a new request is being requested in the background.
   *
   * @see {@link OperationResult.stale} for the source of this value.
   */
  stale: boolean;
  /** The {@link OperationResult.data} for the executed query. */
  data?: Data;
  /** The {@link OperationResult.error} for the executed query. */
  error?: CombinedError;
  /** The {@link OperationResult.hasNext} for the executed query. */
  hasNext: boolean;
  /** The {@link OperationResult.extensions} for the executed query. */
  extensions?: Record<string, any>;
  /** The {@link Operation} that the current state is for.
   *
   * @remarks
   * This is the {@link Operation} that is currently being executed.
   * When {@link UseQueryState.fetching} is `true`, this is the
   * last `Operation` that the current state was for.
   */
  operation?: Operation<Data, Variables>;
}

/** Triggers {@link useQuery} to execute a new GraphQL query operation.
 *
 * @param opts - optionally, context options that will be merged with the hook's
 * {@link UseQueryArgs.context} options and the `Client`’s options.
 *
 * @remarks
 * When called, {@link useQuery} will re-execute the GraphQL query operation
 * it currently holds, even if {@link UseQueryArgs.pause} is set to `true`.
 *
 * This is useful for executing a paused query or re-executing a query
 * and get a new network result, by passing a new request policy.
 *
 * ```ts
 * const [result, reexecuteQuery] = useQuery({ query });
 *
 * const refresh = () => {
 *   // Re-execute the query with a network-only policy, skipping the cache
 *   reexecuteQuery({ requestPolicy: 'network-only' });
 * };
 * ```
 */
export type UseQueryExecute = (opts?: Partial<OperationContext>) => void;

/** Result tuple returned by the {@link useQuery} hook.
 *
 * @remarks
 * Similarly to a `useState` hook’s return value,
 * the first element is the {@link useQuery}’s result and state,
 * a {@link UseQueryState} object,
 * and the second is used to imperatively re-execute the query
 * via a {@link UseQueryExecute} function.
 */
export type UseQueryResponse<
  Data = any,
  Variables extends AnyVariables = AnyVariables,
> = [UseQueryState<Data, Variables>, UseQueryExecute];

const isSuspense = (client: Client, context?: Partial<OperationContext>) =>
  context && context.suspense !== undefined
    ? !!context.suspense
    : client.suspense;

/** Hook to run a GraphQL query and get updated GraphQL results.
 *
 * @param args - a {@link UseQueryArgs} object, to pass a `query`, `variables`, and options.
 * @returns a {@link UseQueryResponse} tuple of a {@link UseQueryState} result, and re-execute function.
 *
 * @remarks
 * `useQuery` allows GraphQL queries to be defined and executed.
 * Given {@link UseQueryArgs.query}, it executes the GraphQL query with the
 * context’s {@link Client}.
 *
 * The returned result updates when the `Client` has new results
 * for the query, and changes when your input `args` change.
 *
 * Additionally, if the `suspense` option is enabled on the `Client`,
 * the `useQuery` hook will suspend instead of indicating that it’s
 * waiting for a result via {@link UseQueryState.fetching}.
 *
 * @see {@link https://urql.dev/goto/urql/docs/basics/react-preact/#queries} for `useQuery` docs.
 *
 * @example
 * ```ts
 * import { gql, useQuery } from 'urql';
 *
 * const TodosQuery = gql`
 *   query { todos { id, title } }
 * `;
 *
 * const Todos = () => {
 *   const [result, reexecuteQuery] = useQuery({
 *     query: TodosQuery,
 *     variables: {},
 *   });
 *   // ...
 * };
 * ```
 */
export function useQuery<
  Data = any,
  Variables extends AnyVariables = AnyVariables,
>(args: UseQueryArgs<Variables, Data>): UseQueryResponse<Data, Variables> {
  const client = useClient();
  const cache = getCacheForClient(client);
  const suspense = isSuspense(client, args.context);
  const request = useRequest(args.query, args.variables as Variables);
  const debug = args.debug !== undefined ? args.debug : false;

  if (debug) {
    console.log('[useQuery] render', {
      requestKey: request.key,
      suspense,
      pause: args.pause,
      requestPolicy: args.requestPolicy,
    });
  }

  const source = React.useMemo(() => {
    if (debug) {
      console.log('[useQuery] useMemo source', {
        pause: args.pause,
        suspense,
        requestKey: request.key,
      });
    }

    if (args.pause) {
      if (debug) console.log('[useQuery] paused, returning null source');
      return null;
    }

    const source = client.executeQuery(request, {
      requestPolicy: args.requestPolicy,
      ...args.context,
    });

    if (debug) {
      console.log('[useQuery] created source', { suspense });
    }

    return suspense
      ? pipe(
          source,
          onPush(result => {
            if (debug) {
              console.log('[useQuery] onPush (suspense cache set)', {
                requestKey: request.key,
                hasData: 'data' in result && result.data !== undefined,
                hasError: 'error' in result && result.error !== undefined,
                stale: result.stale,
                hasNext: result.hasNext,
              });
            }
            cache.set(request.key, result);
          })
        )
      : source;
  }, [
    cache,
    client,
    request,
    suspense,
    args.pause,
    args.requestPolicy,
    args.context,
    debug,
  ]);

  const getSnapshot = React.useCallback(
    (
      source: Source<OperationResult<Data, Variables>> | null,
      suspense: boolean
    ): Partial<UseQueryState<Data, Variables>> => {
      if (debug) {
        console.log('[useQuery] getSnapshot called', {
          hasSource: !!source,
          suspense,
          requestKey: request.key,
        });
      }

      if (!source) {
        if (debug)
          console.log(
            '[useQuery] getSnapshot: no source, returning fetching: false'
          );
        return { fetching: false };
      }

      let result = cache.get(request.key);
      if (debug) {
        console.log('[useQuery] getSnapshot: cache lookup', {
          requestKey: request.key,
          cacheHit: !!result,
          isPromise: result != null && 'then' in result,
          hasData:
            result &&
            !('then' in result) &&
            'data' in result &&
            result.data !== undefined,
          hasError:
            result &&
            !('then' in result) &&
            'error' in result &&
            result.error !== undefined,
        });
      }

      if (!result) {
        let resolve: (value: unknown) => void;

        if (debug)
          console.log(
            '[useQuery] getSnapshot: no cached result, subscribing to source'
          );

        const subscription = pipe(
          source,
          takeWhile(() => {
            const shouldContinue =
              (suspense && !resolve) ||
              !result ||
              ('hasNext' in result && result.hasNext);
            if (debug) {
              console.log('[useQuery] getSnapshot takeWhile check', {
                suspense,
                hasResolve: !!resolve,
                hasResult: !!result,
                hasNext: result && 'hasNext' in result ? result.hasNext : 'N/A',
                shouldContinue,
              });
            }
            return shouldContinue;
          }),
          subscribe(_result => {
            if (debug) {
              console.log(
                '[useQuery] getSnapshot subscription received result',
                {
                  hasData: 'data' in _result && _result.data !== undefined,
                  hasError: 'error' in _result && _result.error !== undefined,
                  stale: _result.stale,
                  hasNext: _result.hasNext,
                }
              );
            }
            result = _result;
            if (resolve) {
              if (debug)
                console.log(
                  '[useQuery] getSnapshot: resolving suspense promise'
                );
              resolve(result);
            }
          })
        );

        if (result == null && suspense) {
          if (debug)
            console.log(
              '[useQuery] getSnapshot: creating suspense promise and throwing'
            );
          const promise = new Promise(_resolve => {
            resolve = _resolve;
          });

          cache.set(request.key, promise);
          throw promise;
        } else {
          if (debug)
            console.log(
              '[useQuery] getSnapshot: unsubscribing (not suspense or has result)'
            );
          subscription.unsubscribe();
        }
      } else if (suspense && result != null && 'then' in result) {
        if (debug)
          console.log(
            '[useQuery] getSnapshot: re-throwing existing suspense promise'
          );
        throw result;
      }

      const finalResult = (result as OperationResult<Data, Variables>) || {
        fetching: true,
      };
      if (debug) {
        console.log('[useQuery] getSnapshot: returning result', {
          hasData: 'data' in finalResult && finalResult.data !== undefined,
          hasError: 'error' in finalResult && finalResult.error !== undefined,
          fetching: 'fetching' in finalResult ? finalResult.fetching : 'N/A',
        });
      }
      return finalResult;
    },
    [cache, request, debug]
  );

  const deps = [
    client,
    request,
    args.requestPolicy,
    args.context,
    args.pause,
  ] as const;

  const [state, setState] = React.useState(() => {
    if (debug) console.log('[useQuery] useState initializer');
    return [
      source,
      computeNextState(
        initialState,
        deferDispatch(() => getSnapshot(source, suspense))
      ),
      deps,
    ] as const;
  });

  let currentResult = state[1];
  if (source !== state[0] && hasDepsChanged(state[2], deps)) {
    if (debug) {
      console.log('[useQuery] deps changed, updating state', {
        sourceChanged: source !== state[0],
        depsChanged: hasDepsChanged(state[2], deps),
      });
    }
    setState([
      source,
      (currentResult = computeNextState(
        state[1],
        deferDispatch(() => getSnapshot(source, suspense))
      )),
      deps,
    ]);
  }

  React.useEffect(() => {
    const source = state[0];
    const request = state[2][1];

    if (debug) {
      console.log('[useQuery] useEffect setup', {
        hasSource: !!source,
        requestKey: request.key,
      });
    }

    let hasResult = false;

    const updateResult = (result: Partial<UseQueryState<Data, Variables>>) => {
      if (debug) {
        console.log('[useQuery] useEffect updateResult', {
          hasData: 'data' in result && result.data !== undefined,
          hasError: 'error' in result && result.error !== undefined,
          fetching: 'fetching' in result ? result.fetching : 'N/A',
          stale: 'stale' in result ? result.stale : 'N/A',
        });
      }
      hasResult = true;
      deferDispatch(setState, state => {
        const nextResult = computeNextState(state[1], result);
        if (debug) {
          console.log('[useQuery] useEffect setState', {
            stateChanged: state[1] !== nextResult,
          });
        }
        return state[1] !== nextResult
          ? [state[0], nextResult, state[2]]
          : state;
      });
    };

    if (source) {
      const subscription = pipe(
        source,
        onEnd(() => {
          if (debug) console.log('[useQuery] useEffect source onEnd');
          updateResult({ fetching: false });
        }),
        subscribe(result => {
          if (debug) {
            console.log('[useQuery] useEffect subscription received', {
              hasData: 'data' in result && result.data !== undefined,
              hasError: 'error' in result && result.error !== undefined,
              stale: result.stale,
              hasNext: result.hasNext,
            });
          }
          updateResult(result);
        })
      );

      if (!hasResult) {
        if (debug)
          console.log(
            '[useQuery] useEffect: no result yet, setting fetching: true'
          );
        updateResult({ fetching: true });
      }

      return () => {
        if (debug)
          console.log('[useQuery] useEffect cleanup', {
            requestKey: request.key,
          });
        cache.dispose(request.key);
        subscription.unsubscribe();
      };
    } else {
      if (debug)
        console.log('[useQuery] useEffect: no source, setting fetching: false');
      updateResult({ fetching: false });
    }
  }, [cache, state[0], state[2][1], debug]);

  const executeQuery = React.useCallback(
    (opts?: Partial<OperationContext>) => {
      if (debug) {
        console.log('[useQuery] executeQuery called', {
          requestKey: request.key,
          opts,
        });
      }

      const context = {
        requestPolicy: args.requestPolicy,
        ...args.context,
        ...opts,
      };

      deferDispatch(setState, state => {
        if (debug) console.log('[useQuery] executeQuery: creating new source');
        const source = suspense
          ? pipe(
              client.executeQuery(request, context),
              onPush(result => {
                if (debug) {
                  console.log(
                    '[useQuery] executeQuery onPush (suspense cache set)',
                    {
                      requestKey: request.key,
                      hasData: 'data' in result && result.data !== undefined,
                      hasError: 'error' in result && result.error !== undefined,
                    }
                  );
                }
                cache.set(request.key, result);
              })
            )
          : client.executeQuery(request, context);
        return [source, state[1], deps];
      });
    },
    [
      client,
      cache,
      request,
      suspense,
      args.requestPolicy,
      args.context,
      args.pause,
      debug,
    ]
  );

  if (debug) {
    console.log('[useQuery] returning result', {
      fetching: currentResult.fetching,
      hasData: currentResult.data !== undefined,
      hasError: currentResult.error !== undefined,
      stale: currentResult.stale,
    });
  }

  return [currentResult, executeQuery];
}

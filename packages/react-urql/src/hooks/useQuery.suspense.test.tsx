// @vitest-environment jsdom
import {
  vi,
  expect,
  it,
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  Mock,
} from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { Client, fetchExchange, gql } from '@urql/core';

import { Provider } from '../context';
import { useQuery, UseQueryExecute } from './useQuery';

const fetch = (globalThis as any).fetch as Mock;
const abort = vi.fn();

interface FetchMockRequest {
  url: string;
  body: { query: string; variables?: Record<string, unknown> };
  resolve: (response: MockResponse) => void;
}

interface MockResponse {
  data?: unknown;
  errors?: Array<{ message: string; path?: string[] }>;
}

interface FetchMockController {
  requests: FetchMockRequest[];
  respond: (
    data: unknown,
    options?: { errors?: Array<{ message: string }> }
  ) => void;
  respondToLatest: (
    data: unknown,
    options?: { errors?: Array<{ message: string }> }
  ) => void;
  respondWithNetworkError: (error: Error) => void;
  reset: () => void;
}

const createFetchMockController = (): FetchMockController => {
  const requests: FetchMockRequest[] = [];
  const pendingResolvers: Array<{
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];

  fetch.mockImplementation((url: string, options?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      let body: {
        query?: string;
        variables?: Record<string, unknown>;
        operationName?: string;
      } | null = null;

      // First try to get body from POST request body
      if (options && options.body) {
        if (typeof options.body === 'string') {
          try {
            body = JSON.parse(options.body);
          } catch {
            body = { query: options.body };
          }
        } else if (options.body instanceof FormData) {
          const operations = options.body.get('operations');
          if (operations && typeof operations === 'string') {
            try {
              body = JSON.parse(operations);
            } catch {
              // ignore
            }
          }
        }
      }

      // For GET requests, extract query/variables from URL
      if (!body && url.includes('?')) {
        const urlObj = new URL(url);
        const query = urlObj.searchParams.get('query');
        const variables = urlObj.searchParams.get('variables');
        const operationName = urlObj.searchParams.get('operationName');
        if (query || variables) {
          body = {
            query: query ?? undefined,
            variables: variables ? JSON.parse(variables) : undefined,
            operationName: operationName ?? undefined,
          };
        }
      }

      const request: FetchMockRequest = {
        url,
        body,
        resolve: (mockResponse: MockResponse) => {
          const responseBody = JSON.stringify({
            data: mockResponse.data,
            errors: mockResponse.errors,
          });
          resolve({
            status: 200,
            headers: { get: () => 'application/json' },
            text: vi.fn().mockResolvedValue(responseBody),
          } as unknown as Response);
        },
      };

      requests.push(request);
      pendingResolvers.push({ resolve: request.resolve as any, reject });
    });
  });

  return {
    requests,
    respond(data, options = {}) {
      const request = requests.find(r => !('resolved' in r));
      if (!request) throw new Error('No pending fetch request');
      request.resolve({ data, errors: options.errors });
      (request as any).resolved = true;
    },
    respondToLatest(data, options = {}) {
      const request = requests[requests.length - 1];
      if (!request) throw new Error('No pending fetch request');
      if ((request as any).resolved)
        throw new Error('Request already resolved');
      request.resolve({ data, errors: options.errors });
      (request as any).resolved = true;
    },
    respondWithNetworkError(error: Error) {
      const pending = pendingResolvers.find(
        (_, i) => !('resolved' in requests[i])
      );
      if (!pending) throw new Error('No pending fetch request');
      pending.reject(error);
    },
    reset() {
      requests.length = 0;
      pendingResolvers.length = 0;
      fetch.mockClear();
    },
  };
};

const assertSuspenseInvariant = (
  pause: boolean,
  data: unknown,
  error: unknown
) => {
  if (!pause && !data && !error) {
    throw new Error(
      'Invariant violation: component rendered without data or error while not paused. ' +
        'With suspense enabled, the component should remain suspended until data or error arrives.'
    );
  }
};

describe('useQuery suspense', () => {
  let fetchMock: FetchMockController;

  beforeAll(() => {
    (globalThis as any).AbortController = function AbortController() {
      this.signal = undefined;
      this.abort = abort;
    };

    vi.spyOn(globalThis.console, 'error').mockImplementation(() => {
      // suppress React error boundary warnings in tests
    });
  });

  beforeEach(() => {
    fetchMock = createFetchMockController();
  });

  afterEach(() => {
    fetchMock.reset();
    abort.mockClear();
  });

  it('should keep suspending until response arrives', async () => {
    const client = new Client({
      url: 'http://localhost:3000/graphql',
      suspense: true,
      exchanges: [fetchExchange],
    });

    const query = gql`
      query TestQuery {
        test
      }
    `;

    const TestComponent = () => {
      const [result] = useQuery({ query });
      return <div data-testid="data">{result.data?.test ?? 'no data'}</div>;
    };

    const Fallback = () => <div data-testid="fallback">Loading...</div>;

    render(
      <Provider value={client}>
        <React.Suspense fallback={<Fallback />}>
          <TestComponent />
        </React.Suspense>
      </Provider>
    );

    // Initially should be suspended (showing fallback)
    expect(screen.getByTestId('fallback')).toBeDefined();

    // Wait a tick to ensure component stays suspended
    await waitFor(() => {
      expect(screen.queryByTestId('fallback')).not.toBeNull();
    });

    // Now emit the actual result with data
    expect(fetchMock.requests.length).toBeGreaterThan(0);
    await act(async () => {
      fetchMock.respondToLatest({ test: 'hello' });
    });

    // Now it should unsuspend and show data
    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).toBe('hello');
    });
  });

  it('should unsuspend when error is received', async () => {
    const client = new Client({
      url: 'http://localhost:3000/graphql',
      suspense: true,
      exchanges: [fetchExchange],
    });

    const query = gql`
      query TestQuery {
        test
      }
    `;

    const TestComponent = () => {
      const [result] = useQuery({ query });
      if (result.error) {
        return <div data-testid="error">{result.error.message}</div>;
      }
      if (result.data) {
        return <div data-testid="data">{result.data.test}</div>;
      }
      return <div data-testid="loading">loading state</div>;
    };

    const Fallback = () => <div data-testid="fallback">Loading...</div>;

    render(
      <Provider value={client}>
        <React.Suspense fallback={<Fallback />}>
          <TestComponent />
        </React.Suspense>
      </Provider>
    );

    // Initially should be suspended
    expect(screen.getByTestId('fallback')).toBeDefined();

    // Wait to ensure component stays suspended
    await waitFor(() => {
      expect(screen.queryByTestId('fallback')).not.toBeNull();
    });

    // Emit error result
    expect(fetchMock.requests.length).toBeGreaterThan(0);
    await act(async () => {
      fetchMock.respondToLatest(null, {
        errors: [{ message: 'Test error' }],
      });
    });

    // Should unsuspend and show error
    await waitFor(
      () => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('error')).toBeDefined();
      },
      { timeout: 3000 }
    );
  });

  describe('pause behavior', () => {
    it('should not suspend when initially paused', async () => {
      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = () => {
        const [result] = useQuery({ query, pause: true });
        assertSuspenseInvariant(true, result.data, result.error);
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent />
          </React.Suspense>
        </Provider>
      );

      // Should NOT show fallback - component renders immediately when paused
      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('data').textContent).toContain(
        'fetching: false'
      );
      expect(screen.getByTestId('data').textContent).toContain('data: none');

      // No query should have been executed
      expect(fetchMock.requests.length).toBe(0);
    });

    it('should start suspending when unpaused', async () => {
      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(pause, result.data, result.error);
        return <div data-testid="data">{result.data?.test ?? 'no data'}</div>;
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      // Initially not suspended when paused
      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('data')).toBeDefined();
      expect(fetchMock.requests.length).toBe(0);

      // Unpause - should start suspending
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      // Should now be suspended
      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      // Query should have been executed
      expect(fetchMock.requests.length).toBeGreaterThan(0);

      // Emit data
      await act(async () => {
        fetchMock.respondToLatest({ test: 'hello' });
      });

      // Should unsuspend and show data
      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toBe('hello');
      });
    });

    it('should stop suspending when paused while suspended', async () => {
      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(pause, result.data, result.error);
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      // Initially suspended
      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      // Pause while suspended
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      // Should stop suspending and show component
      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'fetching: false'
        );
        expect(screen.getByTestId('data').textContent).toContain('data: none');
      });
    });

    it('should keep data when paused after receiving data', async () => {
      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(pause, result.data, result.error);
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      // Wait for suspension
      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      // Emit data
      expect(fetchMock.requests.length).toBeGreaterThan(0);
      await act(async () => {
        fetchMock.respondToLatest({ test: 'hello' });
      });

      // Wait for data to render
      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain('data: hello');
      });

      // Now pause
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      // Should still show data, not suspended
      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'fetching: false'
        );
        expect(screen.getByTestId('data').textContent).toContain('data: hello');
      });
    });

    it('should fetch data when executeQuery called while paused without suspending', async () => {
      let executeQuery: UseQueryExecute;

      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = () => {
        const [result, execute] = useQuery({ query, pause: true });
        executeQuery = execute;
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent />
          </React.Suspense>
        </Provider>
      );

      // Initially not suspended
      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('data').textContent).toContain(
        'fetching: false'
      );
      expect(fetchMock.requests.length).toBe(0);

      // Call executeQuery manually while paused
      act(() => {
        executeQuery();
      });

      // Should NOT suspend (pause is still true, so memoized source is null)
      expect(screen.queryByTestId('fallback')).toBeNull();

      // Query should have been executed
      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      // Emit data
      await act(async () => {
        fetchMock.respondToLatest({ test: 'manual-fetch' });
      });

      // Should show data without ever having suspended
      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'data: manual-fetch'
        );
      });
    });

    it('should handle multiple pause/unpause cycles', async () => {
      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(pause, result.data, result.error);
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      // Initially not suspended
      expect(screen.queryByTestId('fallback')).toBeNull();

      // Cycle 1: Unpause -> Pause while suspended
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'fetching: false'
        );
      });

      // Cycle 2: Unpause -> Get data -> Pause
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      await act(async () => {
        fetchMock.respondToLatest({ test: 'cycle2-data' });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'data: cycle2-data'
        );
      });

      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      // Data should persist while paused
      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'data: cycle2-data'
        );
      });
    });

    it('should use new variables when unpaused after variable change', async () => {
      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const queryWithVars = gql`
        query TestQuery($id: ID!) {
          test(id: $id)
        }
      `;

      const TestComponent = ({ pause, id }: { pause: boolean; id: string }) => {
        const [result] = useQuery({
          query: queryWithVars,
          variables: { id },
          pause,
        });
        assertSuspenseInvariant(pause, result.data, result.error);
        return (
          <div data-testid="data">data: {result.data?.test ?? 'none'}</div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} id="1" />
          </React.Suspense>
        </Provider>
      );

      // Not suspended, no query executed
      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(fetchMock.requests.length).toBe(0);

      // Change variables while paused
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} id="2" />
          </React.Suspense>
        </Provider>
      );

      // Still no query
      expect(fetchMock.requests.length).toBe(0);

      // Unpause
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} id="2" />
          </React.Suspense>
        </Provider>
      );

      // Should suspend and execute query with id="2"
      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      await waitFor(() => {
        expect(fetchMock.requests.length).toBe(1);
        expect(fetchMock.requests[0].body?.variables).toEqual({ id: '2' });
      });
    });
  });

  describe('orphaned promise handling', () => {
    it('should not get stuck in suspense when refetching after subscription teardown', async () => {
      let executeQuery: UseQueryExecute;

      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result, execute] = useQuery({ query, pause });
        executeQuery = execute;
        assertSuspenseInvariant(pause, result.data, result.error);
        return <div data-testid="data">{result.data?.test ?? 'no data'}</div>;
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      // Step 1: Component initially loads and suspends
      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      // Step 2: First result arrives, component unsuspends
      await act(async () => {
        fetchMock.respondToLatest({ test: 'initial' });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toBe('initial');
      });

      // Step 3: User navigates away (pause the query, tearing down subscription)
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
      });

      // Step 4: User navigates back and triggers a refetch
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      // Step 5: Call executeQuery to refetch with network-only
      act(() => {
        executeQuery({ requestPolicy: 'network-only' });
      });

      // Wait for the new request to be made
      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(1);
      });

      // Emit the new result
      await act(async () => {
        fetchMock.respondToLatest({ test: 'refetched' });
      });

      // Step 6: Verify the component gets the new data and doesn't stay stuck
      await waitFor(
        () => {
          expect(screen.getByTestId('data').textContent).toBe('refetched');
        },
        { timeout: 3000 }
      );
    });

    it('should not hang when remounting after unmount during suspension', async () => {
      const client = new Client({
        url: 'http://localhost:3000/graphql',
        suspense: true,
        exchanges: [fetchExchange],
      });

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(pause, result.data, result.error);
        return <div data-testid="data">{result.data?.test ?? 'no data'}</div>;
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { unmount } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      // Initial suspension
      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      // Unmount while still suspended (subscription torn down, promise orphaned)
      unmount();

      // Remount - the key test is that this doesn't hang forever
      render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      // Should suspend again (not hang)
      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      // Emit data - the component should unsuspend
      await act(async () => {
        fetchMock.respondToLatest({ test: 'after-remount' });
      });

      // The critical assertion: component should receive data and unsuspend
      await waitFor(
        () => {
          expect(screen.queryByTestId('fallback')).toBeNull();
          expect(screen.getByTestId('data').textContent).toBe('after-remount');
        },
        { timeout: 3000 }
      );
    });
  });
});

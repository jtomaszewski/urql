// @vitest-environment jsdom
import {
  vi,
  expect,
  it,
  describe,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { gql } from '@urql/core';

import { Provider } from '../context';
import { useQuery, UseQueryExecute } from './useQuery';
import {
  createFetchMockController,
  createTestClient,
  setupSuspenseTestEnvironment,
  assertSuspenseInvariant,
  FetchMockController,
  Fallback,
} from './suspense-test-utils.js';

const abort = vi.fn();

describe('useQuery suspense', () => {
  let fetchMock: FetchMockController;

  beforeAll(() => {
    setupSuspenseTestEnvironment(abort);
  });

  beforeEach(() => {
    fetchMock = createFetchMockController();
  });

  afterEach(() => {
    fetchMock.reset();
    abort.mockClear();
  });

  it('should keep suspending until response arrives', async () => {
    const client = createTestClient();

    const query = gql`
      query TestQuery {
        test
      }
    `;

    const TestComponent = () => {
      const [result] = useQuery({ query });
      return <div data-testid="data">{result.data?.test ?? 'no data'}</div>;
    };

    render(
      <Provider value={client}>
        <React.Suspense fallback={<Fallback />}>
          <TestComponent />
        </React.Suspense>
      </Provider>
    );

    expect(screen.getByTestId('fallback')).toBeDefined();

    await waitFor(() => {
      expect(screen.queryByTestId('fallback')).not.toBeNull();
    });

    expect(fetchMock.requests.length).toBeGreaterThan(0);
    await act(async () => {
      fetchMock.respondToLatest({ test: 'hello' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).toBe('hello');
    });
  });

  it('should unsuspend when error is received', async () => {
    const client = createTestClient();

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

    render(
      <Provider value={client}>
        <React.Suspense fallback={<Fallback />}>
          <TestComponent />
        </React.Suspense>
      </Provider>
    );

    expect(screen.getByTestId('fallback')).toBeDefined();

    await waitFor(() => {
      expect(screen.queryByTestId('fallback')).not.toBeNull();
    });

    expect(fetchMock.requests.length).toBeGreaterThan(0);
    await act(async () => {
      fetchMock.respondToLatest(null, {
        errors: [{ message: 'Test error' }],
      });
    });

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
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = () => {
        const [result] = useQuery({ query, pause: true });
        assertSuspenseInvariant(result, true);
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent />
          </React.Suspense>
        </Provider>
      );

      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('data').textContent).toContain(
        'fetching: false'
      );
      expect(screen.getByTestId('data').textContent).toContain('data: none');

      expect(fetchMock.requests.length).toBe(0);
    });

    it('should start suspending when unpaused', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(result, pause);
        return <div data-testid="data">{result.data?.test ?? 'no data'}</div>;
      };

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('data')).toBeDefined();
      expect(fetchMock.requests.length).toBe(0);

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

      expect(fetchMock.requests.length).toBeGreaterThan(0);

      await act(async () => {
        fetchMock.respondToLatest({ test: 'hello' });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toBe('hello');
      });
    });

    it('should stop suspending when paused while suspended', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(result, pause);
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      const { rerender } = render(
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
        expect(screen.getByTestId('data').textContent).toContain('data: none');
      });
    });

    it('should keep data when paused after receiving data', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(result, pause);
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      expect(fetchMock.requests.length).toBeGreaterThan(0);
      await act(async () => {
        fetchMock.respondToLatest({ test: 'hello' });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain('data: hello');
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
        expect(screen.getByTestId('data').textContent).toContain('data: hello');
      });
    });

    it('should fetch data when executeQuery called while paused without suspending', async () => {
      let executeQuery: UseQueryExecute;

      const client = createTestClient();

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

      render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent />
          </React.Suspense>
        </Provider>
      );

      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('data').textContent).toContain(
        'fetching: false'
      );
      expect(fetchMock.requests.length).toBe(0);

      act(() => {
        executeQuery();
      });

      expect(screen.queryByTestId('fallback')).toBeNull();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest({ test: 'manual-fetch' });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'data: manual-fetch'
        );
      });
    });

    it('should handle multiple pause/unpause cycles', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(result, pause);
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.test ?? 'none'}
          </div>
        );
      };

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      expect(screen.queryByTestId('fallback')).toBeNull();

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

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'data: cycle2-data'
        );
      });
    });

    it('should use new variables when unpaused after variable change', async () => {
      const client = createTestClient();

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
        assertSuspenseInvariant(result, pause);
        return (
          <div data-testid="data">data: {result.data?.test ?? 'none'}</div>
        );
      };

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} id="1" />
          </React.Suspense>
        </Provider>
      );

      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(fetchMock.requests.length).toBe(0);

      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} id="2" />
          </React.Suspense>
        </Provider>
      );

      expect(fetchMock.requests.length).toBe(0);

      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} id="2" />
          </React.Suspense>
        </Provider>
      );

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

      const client = createTestClient();

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result, execute] = useQuery({ query, pause });
        executeQuery = execute;
        assertSuspenseInvariant(result, pause);
        return <div data-testid="data">{result.data?.test ?? 'no data'}</div>;
      };

      const { rerender } = render(
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
        fetchMock.respondToLatest({ test: 'initial' });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toBe('initial');
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
      });

      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      act(() => {
        executeQuery({ requestPolicy: 'network-only' });
      });

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(1);
      });

      await act(async () => {
        fetchMock.respondToLatest({ test: 'refetched' });
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('data').textContent).toBe('refetched');
        },
        { timeout: 3000 }
      );
    });

    it('should not hang when remounting after unmount during suspension', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(result, pause);
        return <div data-testid="data">{result.data?.test ?? 'no data'}</div>;
      };

      const { unmount } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      unmount();

      render(
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
        fetchMock.respondToLatest({ test: 'after-remount' });
      });

      await waitFor(
        () => {
          expect(screen.queryByTestId('fallback')).toBeNull();
          expect(screen.getByTestId('data').textContent).toBe('after-remount');
        },
        { timeout: 3000 }
      );
    });
  });

  describe('suspense invariant edge cases', () => {
    it('should not return { fetching: false } without data when source is null but suspense is enabled', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          test
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        assertSuspenseInvariant(result, pause);
        return (
          <div data-testid="data">
            {result.data?.test ?? 'no data'} (fetching:{' '}
            {String(result.fetching)})
          </div>
        );
      };

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain('no data');
      });

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
        fetchMock.respondToLatest({ test: 'success' });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain('success');
      });
    });
  });
});

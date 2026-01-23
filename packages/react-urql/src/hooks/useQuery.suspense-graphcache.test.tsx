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
import { cacheExchange } from '@urql/exchange-graphcache';

import { Provider } from '../context';
import { useQuery } from './useQuery';

const fetch = (globalThis as any).fetch as Mock;
const abort = vi.fn();

interface FetchMockRequest {
  url: string;
  body: {
    query?: string;
    variables?: Record<string, unknown>;
    operationName?: string;
  } | null;
  resolve: (response: MockResponse) => void;
  resolved?: boolean;
}

interface MockResponse {
  data?: unknown;
  errors?: Array<{ message: string; path?: string[] }>;
  hasNext?: boolean;
}

interface FetchMockController {
  requests: FetchMockRequest[];
  respond: (
    data: unknown,
    options?: {
      errors?: Array<{ message: string; path?: string[] }>;
      hasNext?: boolean;
    }
  ) => void;
  respondToLatest: (
    data: unknown,
    options?: {
      errors?: Array<{ message: string; path?: string[] }>;
      hasNext?: boolean;
    }
  ) => void;
  reset: () => void;
}

const createFetchMockController = (): FetchMockController => {
  const requests: FetchMockRequest[] = [];

  fetch.mockImplementation((url: string, options?: RequestInit) => {
    return new Promise<Response>(resolve => {
      let body: FetchMockRequest['body'] = null;

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
            hasNext: mockResponse.hasNext,
          });
          resolve({
            status: 200,
            headers: { get: () => 'application/json' },
            text: vi.fn().mockResolvedValue(responseBody),
          } as unknown as Response);
        },
      };

      requests.push(request);
    });
  });

  return {
    requests,
    respond(data, options = {}) {
      const request = requests.find(r => !r.resolved);
      if (!request) throw new Error('No pending fetch request');
      request.resolve({
        data,
        errors: options.errors,
        hasNext: options.hasNext,
      });
      request.resolved = true;
    },
    respondToLatest(data, options = {}) {
      const request = requests[requests.length - 1];
      if (!request) throw new Error('No pending fetch request');
      if (request.resolved) throw new Error('Request already resolved');
      request.resolve({
        data,
        errors: options.errors,
        hasNext: options.hasNext,
      });
      request.resolved = true;
    },
    reset() {
      requests.length = 0;
      fetch.mockClear();
    },
  };
};

const createTestClient = (cacheOpts?: Parameters<typeof cacheExchange>[0]) => {
  return new Client({
    url: 'http://test/graphql',
    suspense: true,
    exchanges: [cacheExchange(cacheOpts), fetchExchange],
  });
};

const assertValidSuspenseResult = (
  result: { data?: unknown; error?: unknown; fetching: boolean },
  pause?: boolean
) => {
  if (pause) return;
  const hasData = result.data !== undefined && result.data !== null;
  const hasError = result.error !== undefined;
  if (!hasData && !hasError) {
    throw new Error(
      `Suspense invariant violation: component rendered without data or error. ` +
        `This should never happen - suspense should keep the component suspended. ` +
        `Result: ${JSON.stringify({ data: result.data, error: result.error, fetching: result.fetching })}`
    );
  }
};

describe('useQuery suspense with graphcache', () => {
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

  describe('cache miss scenarios', () => {
    it('should suspend until network response arrives', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = () => {
        const [result] = useQuery({ query });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="data">{result.data?.author?.name ?? 'no data'}</div>
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

      expect(screen.getByTestId('fallback')).toBeDefined();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Test Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('data').textContent).toBe('Test Author');
      });
    });

    it('should handle network errors and unsuspend', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = () => {
        const [result] = useQuery({ query });
        assertValidSuspenseResult(result);
        if (result.error) {
          return <div data-testid="error">{result.error.message}</div>;
        }
        return (
          <div data-testid="data">{result.data?.author?.name ?? 'no data'}</div>
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

      expect(screen.getByTestId('fallback')).toBeDefined();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest(null, {
          errors: [{ message: 'Network failure' }],
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('error')).toBeDefined();
      });
    });
  });

  describe('cache hit scenarios', () => {
    it('should not suspend when data is fully cached', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const PopulateComponent = () => {
        const [result] = useQuery({ query });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="populate">
            {result.data?.author?.name ?? 'loading'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { unmount } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <PopulateComponent />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Cached Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('populate').textContent).toBe(
          'Cached Author'
        );
      });

      unmount();

      const TestComponent = () => {
        const [result] = useQuery({ query });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="data">{result.data?.author?.name ?? 'no data'}</div>
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
      expect(screen.getByTestId('data').textContent).toBe('Cached Author');
    });

    it('should suspend for partial cache hits when requesting additional fields', async () => {
      const client = createTestClient();

      const basicQuery = gql`
        query BasicQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const extendedQuery = gql`
        query ExtendedQuery {
          author {
            __typename
            id
            name
            email
          }
        }
      `;

      const PopulateComponent = () => {
        const [result] = useQuery({ query: basicQuery });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="populate">
            {result.data?.author?.name ?? 'loading'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { unmount } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <PopulateComponent />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Test Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('populate').textContent).toBe('Test Author');
      });

      unmount();

      const ExtendedComponent = () => {
        const [result] = useQuery({ query: extendedQuery });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="extended">
            {result.data?.author?.email ?? 'no email'}
          </div>
        );
      };

      render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <ExtendedComponent />
          </React.Suspense>
        </Provider>
      );

      expect(screen.getByTestId('fallback')).toBeDefined();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBe(2);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Test Author',
            email: 'test@example.com',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('extended').textContent).toBe(
          'test@example.com'
        );
      });
    });
  });

  describe('cache-and-network policy', () => {
    it('should return stale cached data without suspending then update', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const PopulateComponent = () => {
        const [result] = useQuery({ query });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="populate">
            {result.data?.author?.name ?? 'loading'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { unmount } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <PopulateComponent />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Original Name',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('populate').textContent).toBe(
          'Original Name'
        );
      });

      unmount();
      const opsBeforeSecondRender = fetchMock.requests.length;

      const CacheAndNetworkComponent = () => {
        const [result] = useQuery({
          query,
          requestPolicy: 'cache-and-network',
        });
        assertValidSuspenseResult(result);
        return (
          <div>
            <div data-testid="data">
              {result.data?.author?.name ?? 'no data'}
            </div>
            <div data-testid="stale">{result.stale ? 'stale' : 'fresh'}</div>
          </div>
        );
      };

      render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <CacheAndNetworkComponent />
          </React.Suspense>
        </Provider>
      );

      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('data').textContent).toBe('Original Name');

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(
          opsBeforeSecondRender
        );
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Updated Name',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('data').textContent).toBe('Updated Name');
        expect(screen.getByTestId('stale').textContent).toBe('fresh');
      });
    });
  });

  describe('hasNext/streaming queries', () => {
    it('should unsuspend when first chunk with data arrives (hasNext: true)', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = () => {
        const [result] = useQuery({ query });
        assertValidSuspenseResult(result);
        const authorName = result.data?.author?.name ?? 'no author';
        return (
          <div>
            <div data-testid="author">{authorName}</div>
            <div data-testid="hasNext">
              {result.hasNext ? 'streaming' : 'complete'}
            </div>
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

      expect(screen.getByTestId('fallback')).toBeDefined();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest(
          {
            __typename: 'Query',
            author: {
              __typename: 'Author',
              id: '1',
              name: 'Stream Author',
            },
          },
          { hasNext: true }
        );
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('hasNext').textContent).toBe('streaming');
      });

      expect(screen.getByTestId('author').textContent).toBe('Stream Author');
    });

    it('should show complete when response has hasNext: false', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = () => {
        const [result] = useQuery({ query });
        assertValidSuspenseResult(result);
        const authorName = result.data?.author?.name ?? 'no author';
        return (
          <div>
            <div data-testid="author">{authorName}</div>
            <div data-testid="hasNext">
              {result.hasNext ? 'streaming' : 'complete'}
            </div>
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

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest(
          {
            __typename: 'Query',
            author: {
              __typename: 'Author',
              id: '1',
              name: 'Final Author',
            },
          },
          { hasNext: false }
        );
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('hasNext').textContent).toBe('complete');
        expect(screen.getByTestId('author').textContent).toBe('Final Author');
      });
    });
  });

  describe('multiple concurrent queries', () => {
    it('should handle two different queries suspending and resolving independently', async () => {
      const client = createTestClient();

      const authorQuery = gql`
        query AuthorQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const postsQuery = gql`
        query PostsQuery {
          posts {
            __typename
            id
            title
          }
        }
      `;

      const AuthorComponent = () => {
        const [result] = useQuery({ query: authorQuery });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="author">
            {result.data?.author?.name ?? 'no author'}
          </div>
        );
      };

      const PostsComponent = () => {
        const [result] = useQuery({ query: postsQuery });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="posts">{result.data?.posts?.length ?? 0} posts</div>
        );
      };

      const AuthorFallback = () => (
        <div data-testid="author-fallback">Loading author...</div>
      );
      const PostsFallback = () => (
        <div data-testid="posts-fallback">Loading posts...</div>
      );

      render(
        <Provider value={client}>
          <React.Suspense fallback={<AuthorFallback />}>
            <AuthorComponent />
          </React.Suspense>
          <React.Suspense fallback={<PostsFallback />}>
            <PostsComponent />
          </React.Suspense>
        </Provider>
      );

      expect(screen.getByTestId('author-fallback')).toBeDefined();
      expect(screen.getByTestId('posts-fallback')).toBeDefined();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBe(2);
      });

      // Find and respond to author query
      const authorReqIndex = fetchMock.requests.findIndex(
        r => r.body?.operationName === 'AuthorQuery'
      );

      await act(async () => {
        const req = fetchMock.requests[authorReqIndex];
        req.resolve({
          data: {
            __typename: 'Query',
            author: {
              __typename: 'Author',
              id: '1',
              name: 'Concurrent Author',
            },
          },
        });
        req.resolved = true;
      });

      await waitFor(() => {
        expect(screen.queryByTestId('author-fallback')).toBeNull();
        expect(screen.getByTestId('author').textContent).toBe(
          'Concurrent Author'
        );
        expect(screen.getByTestId('posts-fallback')).toBeDefined();
      });

      // Find and respond to posts query
      const postsReqIndex = fetchMock.requests.findIndex(
        r => r.body?.operationName === 'PostsQuery'
      );

      await act(async () => {
        const req = fetchMock.requests[postsReqIndex];
        req.resolve({
          data: {
            __typename: 'Query',
            posts: [
              { __typename: 'Post', id: '1', title: 'Post 1' },
              { __typename: 'Post', id: '2', title: 'Post 2' },
              { __typename: 'Post', id: '3', title: 'Post 3' },
            ],
          },
        });
        req.resolved = true;
      });

      await waitFor(() => {
        expect(screen.queryByTestId('posts-fallback')).toBeNull();
        expect(screen.getByTestId('posts').textContent).toBe('3 posts');
      });
    });
  });

  describe('error handling', () => {
    it('should handle GraphQL errors with partial data', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
          secret {
            __typename
            value
          }
        }
      `;

      const TestComponent = () => {
        const [result] = useQuery({ query });
        assertValidSuspenseResult(result);
        return (
          <div>
            <div data-testid="author">
              {result.data?.author?.name ?? 'no author'}
            </div>
            <div data-testid="error">
              {result.error ? 'has error' : 'no error'}
            </div>
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

      expect(screen.getByTestId('fallback')).toBeDefined();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest(
          {
            __typename: 'Query',
            author: {
              __typename: 'Author',
              id: '1',
              name: 'Partial Author',
            },
            secret: null,
          },
          {
            errors: [
              {
                message: 'Unauthorized',
                path: ['secret'],
              },
            ],
          }
        );
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('author').textContent).toBe('Partial Author');
        expect(screen.getByTestId('error').textContent).toBe('has error');
      });
    });
  });

  describe('variable changes', () => {
    it('should suspend when variables change to uncached values', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery($id: ID!) {
          author(id: $id) {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = ({ authorId }: { authorId: string }) => {
        const [result] = useQuery({ query, variables: { id: authorId } });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="data">{result.data?.author?.name ?? 'no data'}</div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent authorId="1" />
          </React.Suspense>
        </Provider>
      );

      expect(screen.getByTestId('fallback')).toBeDefined();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBe(1);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Author One',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('data').textContent).toBe('Author One');
      });

      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent authorId="2" />
          </React.Suspense>
        </Provider>
      );

      expect(screen.getByTestId('fallback')).toBeDefined();

      await waitFor(() => {
        expect(fetchMock.requests.length).toBe(2);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '2',
            name: 'Author Two',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('data').textContent).toBe('Author Two');
      });
    });

    it('should not suspend when variables change to cached values', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery($id: ID!) {
          author(id: $id) {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = ({ authorId }: { authorId: string }) => {
        const [result] = useQuery({ query, variables: { id: authorId } });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="data">{result.data?.author?.name ?? 'no data'}</div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { rerender } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent authorId="1" />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(fetchMock.requests.length).toBe(1);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Author One',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('data').textContent).toBe('Author One');
      });

      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent authorId="2" />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(fetchMock.requests.length).toBe(2);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '2',
            name: 'Author Two',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('data').textContent).toBe('Author Two');
      });

      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent authorId="1" />
          </React.Suspense>
        </Provider>
      );

      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('data').textContent).toBe('Author One');
    });
  });

  describe('pause behavior', () => {
    it('should not suspend when initially paused', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = () => {
        const [result] = useQuery({ query, pause: true });
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.author?.name ?? 'none'}
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
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        if (!pause) {
          assertValidSuspenseResult(result, pause);
        }
        return (
          <div data-testid="data">{result.data?.author?.name ?? 'no data'}</div>
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
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Unpaused Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toBe('Unpaused Author');
      });
    });

    it('should stop suspending when paused while suspended', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.author?.name ?? 'none'}
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
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        if (!pause) {
          assertValidSuspenseResult(result, pause);
        }
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.author?.name ?? 'none'}
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

      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Fetched Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'data: Fetched Author'
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
          'fetching: false'
        );
        expect(screen.getByTestId('data').textContent).toContain(
          'data: Fetched Author'
        );
      });
    });

    it('should handle multiple pause/unpause cycles', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query, pause });
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.author?.name ?? 'none'}
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
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Cycle Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'data: Cycle Author'
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
          'data: Cycle Author'
        );
      });
    });

    it('should use new variables when unpaused after variable change', async () => {
      const client = createTestClient();

      const query = gql`
        query TestQuery($id: ID!) {
          author(id: $id) {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = ({ pause, id }: { pause: boolean; id: string }) => {
        const [result] = useQuery({ query, variables: { id }, pause });
        if (!pause) {
          assertValidSuspenseResult(result, pause);
        }
        return (
          <div data-testid="data">{result.data?.author?.name ?? 'none'}</div>
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

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '2',
            name: 'Author Two',
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toBe('Author Two');
      });
    });

    it('should not suspend when paused even with graphcache partial result', async () => {
      const client = createTestClient();

      const basicQuery = gql`
        query BasicQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const extendedQuery = gql`
        query ExtendedQuery {
          author {
            __typename
            id
            name
            email
          }
        }
      `;

      const PopulateComponent = () => {
        const [result] = useQuery({ query: basicQuery });
        assertValidSuspenseResult(result);
        return (
          <div data-testid="populate">
            {result.data?.author?.name ?? 'loading'}
          </div>
        );
      };

      const Fallback = () => <div data-testid="fallback">Loading...</div>;

      const { unmount } = render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <PopulateComponent />
          </React.Suspense>
        </Provider>
      );

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(0);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Partial Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('populate').textContent).toBe(
          'Partial Author'
        );
      });

      unmount();

      const ExtendedComponent = ({ pause }: { pause: boolean }) => {
        const [result] = useQuery({ query: extendedQuery, pause });
        return (
          <div data-testid="extended">
            fetching: {String(result.fetching)}, email:{' '}
            {result.data?.author?.email ?? 'none'}
          </div>
        );
      };

      render(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <ExtendedComponent pause={true} />
          </React.Suspense>
        </Provider>
      );

      expect(screen.queryByTestId('fallback')).toBeNull();
      expect(screen.getByTestId('extended').textContent).toContain(
        'fetching: false'
      );
    });

    it('should create new subscription when executeQuery called after pause/unpause cycle', async () => {
      const client = createTestClient();
      let executeQuery: ReturnType<typeof useQuery>[1];

      const query = gql`
        query TestQuery {
          author {
            __typename
            id
            name
          }
        }
      `;

      const TestComponent = ({ pause }: { pause: boolean }) => {
        const [result, execute] = useQuery({ query, pause });
        executeQuery = execute;
        if (!pause) {
          assertValidSuspenseResult(result, pause);
        }
        return (
          <div data-testid="data">
            fetching: {String(result.fetching)}, data:{' '}
            {result.data?.author?.name ?? 'none'}
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

      await waitFor(() => {
        expect(screen.getByTestId('fallback')).toBeDefined();
      });

      expect(fetchMock.requests.length).toBe(1);

      // Respond to first request
      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Initial Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('fallback')).toBeNull();
        expect(screen.getByTestId('data').textContent).toContain(
          'data: Initial Author'
        );
      });

      // Pause the query
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

      const opsBeforeRefetch = fetchMock.requests.length;

      // Unpause the query
      rerender(
        <Provider value={client}>
          <React.Suspense fallback={<Fallback />}>
            <TestComponent pause={false} />
          </React.Suspense>
        </Provider>
      );

      // Explicitly trigger refetch with network-only policy
      act(() => {
        executeQuery({ requestPolicy: 'network-only' });
      });

      await waitFor(() => {
        expect(fetchMock.requests.length).toBeGreaterThan(opsBeforeRefetch);
      });

      await act(async () => {
        fetchMock.respondToLatest({
          __typename: 'Query',
          author: {
            __typename: 'Author',
            id: '1',
            name: 'Refetched Author',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('data').textContent).toContain(
          'data: Refetched Author'
        );
      });
    });
  });
});

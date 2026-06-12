# @urql/expo-router

`@urql/expo-router` integrates `urql` with [Expo Router](https://docs.expo.dev/router/introduction/)'s
streaming server-side rendering (`web.output: 'server'` with the `unstable_useServerRendering`
config-plugin option).

It mirrors [`@urql/next`](https://github.com/urql-graphql/urql/tree/main/packages/next-urql):
suspense query results are serialized into the streamed HTML response as each Suspense
boundary resolves (via Expo Router's `useServerInsertedHTML` hook), and restored into the
`ssrExchange` on the client before the matching boundary hydrates — no client-side refetch
and no per-route loaders.

Requires a version of `expo-router` that ships `useServerInsertedHTML`.

## Usage

Wrap your app with `UrqlProvider` (replacing urql's plain `Provider`):

```tsx
import { useMemo } from 'react';
import {
  UrqlProvider,
  ssrExchange,
  cacheExchange,
  fetchExchange,
  createClient,
} from '@urql/expo-router';

export default function RootLayout({ children }: React.PropsWithChildren) {
  const [client, ssr] = useMemo(() => {
    const ssr = ssrExchange();
    const client = createClient({
      url: 'https://example.com/graphql',
      exchanges: [cacheExchange, ssr, fetchExchange],
      suspense: true,
    });
    return [client, ssr];
  }, []);

  return (
    <UrqlProvider client={client} ssr={ssr}>
      {children}
    </UrqlProvider>
  );
}
```

Then use `useQuery` from `@urql/expo-router` (instead of `urql`) in components rendered
inside Suspense boundaries. On native platforms and in client-side navigation, the
hooks behave exactly like their `urql` counterparts.

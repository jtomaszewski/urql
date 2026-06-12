'use client';

import * as React from 'react';
import type { SSRExchange, Client } from 'urql';
import { Provider } from 'urql';
import { DataHydrationContextProvider } from './DataHydrationContext';

export const SSRContext = React.createContext<SSRExchange | undefined>(
  undefined
);

/** Provider for `@urql/expo-router`.
 *
 * @remarks
 * `UrqlProvider` accepts a {@link Client} and provides it to all GraphQL hooks. It
 * also accepts an {@link SSRExchange} to distribute data when re-hydrating
 * on the client.
 *
 * During streaming server-side rendering (Expo Router `web.output: 'server'` with
 * `unstable_useServerRendering`), suspense query results are serialized into the
 * HTML stream as each Suspense boundary resolves, and restored into the
 * {@link SSRExchange} on the client before the matching boundary hydrates.
 *
 * @example
 * ```tsx
 * import { useMemo } from 'react';
 * import {
 *  UrqlProvider,
 *  ssrExchange,
 *  cacheExchange,
 *  fetchExchange,
 *  createClient,
 * } from '@urql/expo-router';
 *
 * export default function Layout({ children }: React.PropsWithChildren) {
 *  const [client, ssr] = useMemo(() => {
 *    const ssr = ssrExchange();
 *      const client = createClient({
 *      url: 'https://trygql.formidable.dev/graphql/web-collections',
 *      exchanges: [cacheExchange, ssr, fetchExchange],
 *      suspense: true,
 *    });
 *
 *    return [client, ssr];
 *  }, []);
 *
 *  return (
 *    <UrqlProvider client={client} ssr={ssr}>
 *      {children}
 *    </UrqlProvider>
 *  );
 * }
 *
 * ```
 */
export function UrqlProvider({
  children,
  ssr,
  client,
  nonce,
}: React.PropsWithChildren<{
  ssr: SSRExchange;
  client: Client;
  nonce?: string;
}>) {
  return React.createElement(
    Provider,
    { value: client },
    React.createElement(
      SSRContext.Provider,
      { value: ssr },
      React.createElement(DataHydrationContextProvider, { nonce }, children)
    )
  );
}

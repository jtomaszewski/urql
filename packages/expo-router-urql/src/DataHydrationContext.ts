'use client';

import * as React from 'react';
import { useServerInsertedHTML } from 'expo-router';
import type { UrqlResult } from './useUrqlValue';
import { htmlEscapeJsonString } from './htmlescape';

interface DataHydrationValue {
  operationValuesByKey: Record<number, UrqlResult>;
  RehydrateScript: () =>
    | React.DetailedReactHTMLElement<
        { dangerouslySetInnerHTML: { __html: string } },
        HTMLElement
      >
    | React.FunctionComponentElement<any>;
}

const DataHydrationContext = React.createContext<
  DataHydrationValue | undefined
>(undefined);

function transportDataToJS(data: any) {
  const key = 'urql_transport';
  return `(window[Symbol.for("${key}")] ??= []).push(${htmlEscapeJsonString(
    JSON.stringify(data)
  )})`;
}

export const DataHydrationContextProvider = ({
  nonce,
  children,
}: React.PropsWithChildren<{ nonce?: string }>) => {
  const dataHydrationContext = React.useRef<DataHydrationValue>();
  if (typeof window == 'undefined') {
    if (!dataHydrationContext.current)
      dataHydrationContext.current = buildContext({ nonce });
  }

  // Expo Router invokes the inserted-HTML callback on every React flush of the
  // streaming SSR response, so a single registration drains all query results
  // accumulated since the previous flush. On the client and on native platforms
  // `useServerInsertedHTML` is a no-op.
  useServerInsertedHTML(() => {
    if (!dataHydrationContext.current) return null;
    return React.createElement(
      dataHydrationContext.current.RehydrateScript,
      {}
    );
  });

  return React.createElement(
    DataHydrationContext.Provider,
    { value: dataHydrationContext.current },
    children
  );
};

export function useDataHydrationContext(): DataHydrationValue | undefined {
  const dataHydrationContext = React.useContext(DataHydrationContext);

  if (typeof window !== 'undefined') return;

  return dataHydrationContext;
}

let key = 0;
function buildContext({ nonce }: { nonce?: string }): DataHydrationValue {
  const dataHydrationContext: DataHydrationValue = {
    operationValuesByKey: {},
    RehydrateScript() {
      if (!Object.keys(dataHydrationContext.operationValuesByKey).length)
        return React.createElement(React.Fragment);

      const __html = transportDataToJS({
        rehydrate: { ...dataHydrationContext.operationValuesByKey },
      });

      dataHydrationContext.operationValuesByKey = {};

      return React.createElement('script', {
        key: key++,
        nonce: nonce,
        dangerouslySetInnerHTML: { __html },
      });
    },
  };

  return dataHydrationContext;
}

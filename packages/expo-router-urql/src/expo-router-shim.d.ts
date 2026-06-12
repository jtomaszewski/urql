// Ambient declaration for the subset of `expo-router` this package consumes.
// `expo-router` is a peer dependency and is intentionally not installed in this
// repository (it would pull in the whole Expo/React Native dependency tree).
// The `useServerInsertedHTML` hook ships with Expo Router's streaming SSR
// support (expo/expo#TBD); replace this shim with a real devDependency once a
// version containing the hook is published.
declare module 'expo-router' {
  export function useServerInsertedHTML(
    callback: () => import('react').ReactNode
  ): void;
}

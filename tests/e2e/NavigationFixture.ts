export function useRouter() {
  return {
    push(path: string) { window.location.assign(path); },
    refresh() {},
  };
}

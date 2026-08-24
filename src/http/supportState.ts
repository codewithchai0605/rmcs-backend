export let showSupport = true;

export function getShowSupport(): boolean {
  return showSupport;
}

export function setShowSupport(show: boolean): boolean {
  showSupport = show;
  return showSupport;
}

export function toggleShowSupport(): boolean {
  showSupport = !showSupport;
  return showSupport;
}
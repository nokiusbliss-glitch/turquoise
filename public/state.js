export const State = Object.freeze({
  IDLE: "IDLE",
  GROUP: "GROUP",
  CALL: "CALL",
  FILE: "FILE"
});

let currentState = State.IDLE;

export function setState(newState) {
  if (!Object.values(State).includes(newState)) {
    throw new Error("Invariant violated: invalid state");
  }
  currentState = newState;
}

export function getState() {
  return currentState;
}
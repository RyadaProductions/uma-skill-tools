import { Strategy } from "./HorseTypes";

export const BaseMinimumThreshold = Object.freeze([0, 0, 3.0, 6.5, 7.5]);
export const BaseMaximumThreshold = Object.freeze([0, 0, 5.0, 7.0, 8.0]);

export function courseFactor(distance: number) {
    return 0.0008 * (distance - 1000) + 1.0;
}

export function minThreshold(strategy: Strategy, distance: number) {
    // senkou minimum threshold is a constant 3.0 independent of the course factor for some reason
    return BaseMinimumThreshold[strategy] * (strategy == Strategy.Senkou ? 1.0 : courseFactor(distance));
}

export function maxThreshold(strategy: Strategy, distance: number) {
    return BaseMaximumThreshold[strategy] * courseFactor(distance);
}
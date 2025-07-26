export function staminaSyoubuDistanceFactor(distance: number) {
    if (distance < 2101) return 0.0;
    else if (distance < 2201) return 0.5;
    else if (distance < 2401) return 1.0;
    else if (distance < 2601) return 1.2;
    else return 1.5;
}

export function staminaSyoubuCalcApproximateModifier(stamina: number, distance: number) {
    const randomFactor = 1.0;  // TODO implement random factor scaling based on power (unclear how this works currently)
    return Math.sqrt(stamina - 1200) * 0.0085 * staminaSyoubuDistanceFactor(distance) * randomFactor;
}
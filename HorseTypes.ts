export const enum Strategy { Nige = 1, Senkou, Sasi, Oikomi, Oonige }
export const enum Aptitude { S, A, B, C, D, E, F, G }

export interface HorseParameters {
	readonly speed: number
	readonly stamina: number
	readonly power: number
	readonly guts: number
	readonly wisdom: number
	readonly strategy: Strategy
	readonly distanceAptitude: Aptitude
	readonly surfaceAptitude: Aptitude
	readonly strategyAptitude: Aptitude
	readonly rawStamina: number
}

export class StrategyHelpers {
	public assertIsStrategy(strategy: number): Strategy {
		if (!Strategy.hasOwnProperty(strategy)) {
			throw new Error("unsupported strategy");
		}
		return strategy as Strategy;
	}

	public strategyMatches(s1: Strategy, s2: Strategy) {
		return s1 == s2 || (s1 == Strategy.Nige && s2 == Strategy.Oonige) || (s1 == Strategy.Oonige && s2 == Strategy.Nige);
	}
}

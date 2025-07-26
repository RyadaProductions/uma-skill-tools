import { DistanceType } from './CourseData';
import { Strategy } from './HorseTypes';

export const AsitameStrategyDistanceCoefficient = Object.freeze([
	[], // distances are 1-indexed (as are strategies, hence the 0 in the first column for every row)
	[0, 1.0, 0.7, 0.75, 0.7, 1.0], // short (nige, senkou, sasi, oikomi, oonige)
	[0, 1.0, 0.8, 0.7, 0.75, 1.0], // mile
	[0, 1.0, 0.9, 0.875, 0.86, 1.0], // medium
	[0, 1.0, 0.9, 1.0, 0.9, 1.0] // long
]);

export const AsitameBaseModifier = 0.00875;

export function AsitameCalcApproximateModifier(power: number, strategy: Strategy, distance: DistanceType) {
	return AsitameBaseModifier * Math.sqrt(power - 1200) * AsitameStrategyDistanceCoefficient[distance][strategy];
}

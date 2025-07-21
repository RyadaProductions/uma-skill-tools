export type Phase = 0 | 1 | 2 | 3;
export const enum Surface { Turf = 1, Dirt }
export const enum DistanceType { Short = 1, Mile, Mid, Long }
export const enum Orientation { Clockwise = 1, Counterclockwise, UnusedOrientation, NoTurns }
export const enum ThresholdStat { Speed = 1, Stamina, Power, Guts, Int }

export interface CourseData {
	readonly raceTrackId: number
	readonly distance: number
	readonly distanceType: DistanceType
	readonly surface: Surface
	readonly turn: Orientation
	readonly courseSetStatus: readonly ThresholdStat[]
	readonly corners: readonly {readonly start: number, readonly length: number}[]
	readonly straights: readonly {readonly start: number, readonly end: number, readonly frontType: number}[]
	readonly slopes: readonly {readonly start: number, readonly length: number, readonly slope: number}[]
}

import courses from './data/course_data.json';

export class CourseHelpers {
	public assertIsPhase(phase: number): Phase {
		if (phase !== 0 && phase !== 1 && phase !== 2 && phase !== 3) {
			throw new Error("unsupported phase");
		}
		return phase as Phase
	}

	public assertIsSurface(surface: number): Surface {
		if (!Surface.hasOwnProperty(surface)) {
			throw new Error("unsupported surface");
		}
		return surface as Surface;
	}

	public assertIsDistanceType(distanceType: number): DistanceType {
		if(DistanceType.hasOwnProperty(distanceType)) {
			throw new Error("unsupported distanceType");
		}
		return distanceType as DistanceType;
	}

	public assertIsOrientation(orientation: number): Orientation {
		if(Orientation.hasOwnProperty(orientation)){
			throw new Error("unsupported orientation");
		}
		return orientation as Orientation;
	}

	public isSortedByStart(arr: readonly {readonly start: number}[]) {
		// typescript seems to have some trouble inferring tuple types, presumably because it doesn't really
		// sufficiently distinguish tuples from arrays
		// so dance around a little bit to make it work
		const init: [boolean, number] = [true, -1];
		function isSorted(a: [boolean, number], b: {start: number}): [boolean,number] {
			return [a[0] && b.start > a[1], b.start];
		}
		return arr.reduce(isSorted, init)[0];
	}

	public phaseStart(distance: number, phase: Phase) {
		switch (phase) {
		case 0: return 0;
		case 1: return distance * 1/6;
		case 2: return distance * 2/3;
		case 3: return distance * 5/6;
		}
	}

	public phaseEnd(distance: number, phase: Phase) {
		switch (phase) {
		case 0: return distance * 1/6;
		case 1: return distance * 2/3;
		case 2: return distance * 5/6;
		case 3: return distance;
		}
	}

	public courseSpeedModifier(
		course: CourseData,
		stats: Readonly<{speed: number, stamina: number, power: number, guts: number, wisdom: number}>
	) {
		const statvalues = [0, stats.speed, stats.stamina, stats.power, stats.guts, stats.wisdom].map(x => Math.min(x, 901));
		return 1 + course.courseSetStatus.map(
			stat => (1 + Math.floor(statvalues[stat] / 300.01)) * 0.05
		).reduce((a,b) => a + b, 0) / Math.max(course.courseSetStatus.length,1);
	}

	public getCourse(courseId: number): CourseData {
		const course = courses[courseId];
		if (!this.isSortedByStart(course.slopes)) course.slopes.sort((a,b) => a.start - b.start);
		Object.keys(course).forEach(k => Object.freeze(course[k]));
		return Object.freeze(course);
	}
}
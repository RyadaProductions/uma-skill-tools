import { Strategy, HorseParameters, StrategyHelpers } from './HorseTypes';
import { CourseData, CourseHelpers, Phase } from './CourseData';
import { Region } from './Region';
import { PRNG, Rule30CARng } from './Random';
import type { HpPolicy } from './HpPolicy';
import { maxThreshold, minThreshold } from './positionKeep';
import { AccelerationDistanceProficiencyModifier, AccelerationGroundTypeProficiencyModifier, AccelerationStrategyPhaseCoefficient } from './acceleration';
import { SpeedDistanceProficiencyModifier, SpeedStrategyPhaseCoefficient } from './speed';

const courseHelpers = new CourseHelpers();
const strategyHelpers = new StrategyHelpers();

let CC_GLOBAL: boolean;

// for the browser builds, CC_GLOBAL is defined by esbuild as true/false
// for node however we have to manually define it as false
// annoyingly we can't use `var` here to define it locally because esbuild rewrites all uses of that to not be
// replaced by the define
// not entirely happy with this solution
if (typeof CC_GLOBAL == "undefined") CC_GLOBAL = false;

function baseSpeed(course: CourseData) {
	return 20.0 - (course.distance - 2000) / 1000.0;
}

function baseTargetSpeed(horse: HorseParameters, course: CourseData, phase: Phase) {
	return baseSpeed(course) * SpeedStrategyPhaseCoefficient[horse.strategy][phase] +
		+(phase == 2) * Math.sqrt(500.0 * horse.speed) *
		SpeedDistanceProficiencyModifier[horse.distanceAptitude] *
		0.002;
}

function lastSpurtSpeed(horse: HorseParameters, course: CourseData) {
	let v = (baseTargetSpeed(horse, course, 2) + 0.01 * baseSpeed(course)) * 1.05 +
		Math.sqrt(500.0 * horse.speed) * SpeedDistanceProficiencyModifier[horse.distanceAptitude] * 0.002;
	if (!CC_GLOBAL) {
		v += Math.pow(450.0 * horse.guts, 0.597) * 0.0001;
	}
	return v;
}

const BaseAccel = 0.0006;
const UphillBaseAccel = 0.0004;

function baseAccel(baseAccel: number, horse: HorseParameters, phase: Phase) {
	return baseAccel * Math.sqrt(500.0 * horse.power) *
	  AccelerationStrategyPhaseCoefficient[horse.strategy][phase] *
	  AccelerationGroundTypeProficiencyModifier[horse.surfaceAptitude] *
	  AccelerationDistanceProficiencyModifier[horse.distanceAptitude];
}

const PhaseDeceleration = [-1.2, -0.8, -1.0];

// these are commonly initialized with a negative number and then checked >= 0 to see if a duration is up
// (the reason for doing that instead of initializing with 0 and then checking against the duration is if
// the code that checks for the duration expiring is separate from the code that initializes the timer and
// has to deal with different durations)
export class Timer {
	constructor(public t: number) {}
}

export class CompensatedAccumulator {
	constructor(public acc: number, public err: number = 0.0) {}

	add(n: number) {
		const t = this.acc + n;
		if (Math.abs(this.acc) >= Math.abs(n)) {
			this.err += (this.acc - t) + n;
		} else {
			this.err += (n - t) + this.acc;
		}
		this.acc = t;
	}
}

export interface RaceState {
	readonly accumulatetime: Readonly<Timer>
	readonly activateCount: readonly number[]
	readonly activateCountHeal: number
	readonly currentSpeed: number
	readonly isLastSpurt: boolean
	readonly lastSpurtSpeed: number
	readonly lastSpurtTransition: number
	readonly isPaceDown: boolean
	readonly phase: Phase
	readonly pos: number
	readonly hp: Readonly<HpPolicy>
	readonly startDelay: number
	readonly usedSkills: ReadonlySet<string>
}

export type DynamicCondition = (state: RaceState) => boolean;

export const enum Perspective {
	Self = 1,
	Other = 2,
	Any = 3
}

export enum SkillType {
	SpeedUp = 1,
	StaminaUp = 2,
	PowerUp = 3,
	GutsUp = 4,
	WisdomUp = 5,
	Recovery = 9,
	MultiplyStartDelay = 10,
	SetStartDelay = 14,
	CurrentSpeed = 21,
	CurrentSpeedWithNaturalDeceleration = 22,
	TargetSpeed = 27,
	Accel = 31,
	ActivateRandomGold = 37,
	ExtendEvolvedDuration = 42
}

export const enum SkillRarity { White = 1, Gold, Unique, Evolution = 6 }

export interface SkillEffect {
	type: SkillType
	baseDuration: number
	modifier: number
}

export interface PendingSkill {
	skillId: string
	perspective?: Perspective
	rarity: SkillRarity
	trigger: Region
	extraCondition: DynamicCondition
	effects: SkillEffect[]
}

interface ActiveSkill {
	skillId: string
	perspective?: Perspective
	durationTimer: Timer
	modifier: number
}

function noop(x: unknown) {}

export class RaceSolver {
	accumulatetime: Timer
	pos: number
	minSpeed: number
	currentSpeed: number
	targetSpeed: number
	accel: number
	baseTargetSpeed: number[]
	lastSpurtSpeed: number
	lastSpurtTransition: number
	baseAccel: number[]
	horse: { -readonly[P in keyof HorseParameters]: HorseParameters[P] }
	course: CourseData
	hp: HpPolicy
	rng: PRNG
	gorosiRng: PRNG
	paceEffectRng: PRNG
	timers: Timer[]
	startDash: boolean
	startDelay: number
	isLastSpurt: boolean
	phase: Phase
	nextPhaseTransition: number
	activeTargetSpeedSkills: ActiveSkill[]
	activeCurrentSpeedSkills: (ActiveSkill & {naturalDeceleration: boolean})[]
	activeAccelSkills: ActiveSkill[]
	pendingSkills: PendingSkill[]
	pendingRemoval: Set<string>
	usedSkills: Set<string>
	nHills: number
	hillIdx: number
	hillStart: number[]
	hillEnd: number[]
	activateCount: number[]
	activateCountHeal: number
	onSkillActivate: (s: RaceSolver, skillId: string, perspective: Perspective) => void
	onSkillDeactivate: (s: RaceSolver, skillId: string, perspective: Perspective) => void
	sectionLength: number
	pacer: RaceSolver | null
	isPaceDown: boolean
	posKeepMinThreshold: number
	posKeepMaxThreshold: number
	posKeepCooldown: Timer
	posKeepEnd: number
	posKeepSpeedCoef: number
	posKeepEffectStart: number
	posKeepEffectExitDistance: number
	updatePositionKeep: () => void

	modifiers: {
		targetSpeed: CompensatedAccumulator
		currentSpeed: CompensatedAccumulator
		accel: CompensatedAccumulator
		oneFrameAccel: number
		specialSkillDurationScaling: number
	}

	constructor(params: {
		horse: HorseParameters,
		course: CourseData,
		rng: PRNG,
		skills: PendingSkill[],
		hp?: HpPolicy,
		pacer?: RaceSolver,
		onSkillActivate?: (s: RaceSolver, skillId: string) => void,
		onSkillDeactivate?: (s: RaceSolver, skillId: string) => void
	}) {
		// clone since green skills may modify the stat values
		this.horse = Object.assign({}, params.horse);
		this.course = params.course;
		this.hp = params.hp || null;
		this.pacer = params.pacer || null;
		this.rng = params.rng;
		this.pendingSkills = params.skills.slice();  // copy since we remove from it
		this.pendingRemoval = new Set();
		this.usedSkills = new Set();
		this.gorosiRng = new Rule30CARng(this.rng.int32());
		this.paceEffectRng = new Rule30CARng(this.rng.int32());
		this.timers = [];
		this.accumulatetime = this.getNewTimer();
		this.phase = 0;
		this.nextPhaseTransition = courseHelpers.phaseStart(this.course.distance, 1);
		this.activeTargetSpeedSkills = [];
		this.activeCurrentSpeedSkills = [];
		this.activeAccelSkills = [];
		this.activateCount = [0,0,0];
		this.activateCountHeal = 0;
		this.onSkillActivate = params.onSkillActivate || noop;
		this.onSkillDeactivate = params.onSkillDeactivate || noop;
		this.sectionLength = this.course.distance / 24.0;
		this.isPaceDown = false;
		this.posKeepMinThreshold = minThreshold(this.horse.strategy, this.course.distance);
		this.posKeepMaxThreshold = maxThreshold(this.horse.strategy, this.course.distance);
		this.posKeepCooldown = this.getNewTimer();
		// NB. in the actual game, position keep continues for 10 sections. however we're really only interested in pace down at
		// the beginning, which is somewhat predictable. arbitrarily cap at 5.
		this.posKeepEnd = this.sectionLength * 5.0;
		this.posKeepSpeedCoef = 1.0;
		if (strategyHelpers.strategyMatches(this.horse.strategy, Strategy.Nige) || this.pacer == null) {
			this.updatePositionKeep = noop as any;
		} else {
			this.updatePositionKeep = this.updatePositionKeepNonNige;
		}

		this.modifiers = {
			targetSpeed: new CompensatedAccumulator(0.0),
			currentSpeed: new CompensatedAccumulator(0.0),
			accel: new CompensatedAccumulator(0.0),
			oneFrameAccel: 0.0,
			specialSkillDurationScaling: 1.0
		};

		this.initHills();

		// must come before the first round of skill activations so concen etc can modify it
		this.startDelay = 0.1 * this.rng.random();
		if (this.pacer) {
			this.pacer.startDelay = 0.0;
			// NB. we skip updating the pacer in step() below if accumulatetime < dt so this effectively just synchronizes start times.
			// not entirely sure this is the correct thing to do, but i consider it somewhat logical to minimize rng-start-delay introduced
			// differences that we're not particularly interested in.
		}

		this.pos = 0.0;
		this.accel = 0.0;
		this.currentSpeed = 3.0;
		this.targetSpeed = 0.85 * baseSpeed(this.course);
		this.processSkillActivations();  // activate gate skills (must come before setting minimum speed because green skills can modify guts)
		this.minSpeed = 0.85 * baseSpeed(this.course) + Math.sqrt(200.0 * this.horse.guts) * 0.001;
		this.startDash = true;
		this.modifiers.accel.add(24.0);  // start dash accel

		// similarly this must also come after the first round of skill activations
		this.baseTargetSpeed = ([0,1,2] as Phase[]).map(phase => baseTargetSpeed(this.horse, this.course, phase));
		this.lastSpurtSpeed = lastSpurtSpeed(this.horse, this.course);
		this.lastSpurtTransition = -1;

		this.hp.init(this.horse);

		this.baseAccel = ([0,1,2,0,1,2] as Phase[]).map((phase,i) => baseAccel(i > 2 ? UphillBaseAccel : BaseAccel, this.horse, phase));
	}

	initHills() {
		// note that slopes are not always sorted by start location in course_data.json
		// sometimes (?) they are sorted by hill type and then by start
		// require this here because the code relies on encountering them sequentially
		if (!courseHelpers.isSortedByStart(this.course.slopes)) {
			throw new Error('slopes must be sorted by start location');
		}

		this.nHills = this.course.slopes.length;
		this.hillStart = this.course.slopes.map(s => s.start).reverse();
		this.hillEnd = this.course.slopes.map(s => s.start + s.length).reverse();
		this.hillIdx = -1;
		if (this.hillStart.length > 0 && this.hillStart[this.hillStart.length - 1] == 0) {
			if (this.course.slopes[0].slope > 0) {
				this.hillIdx = 0;
			} else {
				this.hillEnd.pop();
			}
			this.hillStart.pop();
		}
	}

	getNewTimer(t: number = 0) {
		const tm = new Timer(t);
		this.timers.push(tm);
		return tm;
	}

	getMaxSpeed() {
		if (this.startDash) {
			// target speed can be below 0.85 * BaseSpeed for non-runners if there is a hill at the start of the course
			// in this case you actually don't exit start dash until your target speed is high enough to be over 0.85 * BaseSpeed
			return Math.min(this.targetSpeed, 0.85 * baseSpeed(this.course));
		} else  if (this.currentSpeed + this.modifiers.oneFrameAccel > this.targetSpeed) {
			return 9999.0;  // allow decelerating if targetSpeed drops
		} else {
			return this.targetSpeed;
		}
		// technically, there's a hard cap of 30m/s, but there's no way to actually hit that without implementing the Pace Up Ex position keep mode
	}

	step(dt: number) {
		// velocity verlet integration
		// do this half-step update of velocity (halfv) because during the start dash acceleration depends on velocity
		// (ie, velocity is given by the following system of differential equations)
		//
		// x′(t + Δt) = x′(t) + Δt * x′′(t + Δt)
		//               ⎧ baseAccel(horse) + accelSkillModifier + 24.0	if x′(t) < 0.85 * baseSpeed(course)
		// x′′(t + Δt) = ⎨
		//               ⎩ baseAccel(horse) + accelSkillModifier		if x′(t) ≥ 0.85 * baseSpeed(course)
		//
		// i dont actually know anything about numerical analysis but i saw this on the internet

		if (this.accumulatetime.t < this.startDelay) {
			const partialFrame = this.startDelay - this.accumulatetime.t;
			if (partialFrame < dt) {
				this.timers.forEach(tm => tm.t += partialFrame);
				dt -= partialFrame;
			} else {
				// still must progress timers
				this.timers.forEach(tm => tm.t += dt);
				return;
			}
		}

		if (this.pos < this.posKeepEnd && this.pacer != null) {
			this.pacer.step(dt);
		}

		const halfv = Math.min(this.currentSpeed + 0.5 * dt * this.accel, this.getMaxSpeed());
		const displacement = halfv + this.modifiers.currentSpeed.acc + this.modifiers.currentSpeed.err;
		this.pos += displacement * dt;
		this.hp.tick(this, dt);
		this.timers.forEach(tm => tm.t += dt);
		this.updateHills();
		this.updatePhase();
		this.processSkillActivations();
		this.updatePositionKeep();
		this.updateLastSpurtState();
		this.updateTargetSpeed();
		this.applyForces();
		this.currentSpeed = Math.min(halfv + 0.5 * dt * this.accel + this.modifiers.oneFrameAccel, this.getMaxSpeed());
		if (!this.startDash && this.currentSpeed < this.minSpeed) {
			this.currentSpeed = this.minSpeed;
		} else if (this.startDash && this.currentSpeed >= 0.85 * baseSpeed(this.course)) {
			this.startDash = false;
			this.modifiers.accel.add(-24.0);
		}
		this.modifiers.oneFrameAccel = 0.0;
	}

	updatePositionKeepNonNige() {
		if (this.pos >= this.posKeepEnd) {
			this.isPaceDown = false;
			this.posKeepSpeedCoef = 1.0;
			this.updatePositionKeep = noop as any;
		} else if (this.isPaceDown) {
			if (
			   this.pacer.pos - this.pos > this.posKeepEffectExitDistance
			|| this.pos - this.posKeepEffectStart > this.sectionLength
			|| this.activeTargetSpeedSkills.length > 0
			|| this.activeCurrentSpeedSkills.length > 0
			) {
				this.isPaceDown = false;
				this.posKeepCooldown.t = -3.0;
				this.posKeepSpeedCoef = 1.0;
			}
		} else if (
			   this.pacer.pos - this.pos < this.posKeepMinThreshold
			&& this.activeTargetSpeedSkills.length == 0
			&& this.activeCurrentSpeedSkills.length == 0
			&& this.posKeepCooldown.t >= 0
		) {
			this.isPaceDown = true;
			this.posKeepEffectStart = this.pos;
			const min = this.posKeepMinThreshold;
			const max = this.phase == 1 ? min + 0.5 * (this.posKeepMaxThreshold - min) : this.posKeepMaxThreshold;
			this.posKeepEffectExitDistance = min + this.paceEffectRng.random() * (max - min);
			this.posKeepSpeedCoef = this.phase == 1 ? 0.945 : 0.915;
		}
	}

	updateLastSpurtState() {
		if (this.isLastSpurt || this.phase < 2) return;
		if (this.lastSpurtTransition == -1) {
			const v = this.hp.getLastSpurtPair(this, this.lastSpurtSpeed, this.baseTargetSpeed[2]);
			this.lastSpurtTransition = v[0];
			this.lastSpurtSpeed = v[1];
		}
		if (this.pos >= this.lastSpurtTransition) {
			this.isLastSpurt = true;
		}
	}

	updateTargetSpeed() {
		if (!this.hp.hasRemainingHp()) {
			this.targetSpeed = this.minSpeed;
		} else if (this.isLastSpurt) {
			this.targetSpeed = this.lastSpurtSpeed;
		} else {
			this.targetSpeed = this.baseTargetSpeed[this.phase] * this.posKeepSpeedCoef;
		}
		this.targetSpeed += this.modifiers.targetSpeed.acc + this.modifiers.targetSpeed.err;

		if (this.hillIdx != -1) {
			// recalculating this every frame is actually measurably faster than calculating the penalty for each slope ahead of time, somehow
			this.targetSpeed -= this.course.slopes[this.hillIdx].slope / 10000.0 * 200.0 / this.horse.power;
			this.targetSpeed = Math.max(this.targetSpeed, this.minSpeed);
		}
	}

	applyForces() {
		if (!this.hp.hasRemainingHp()) {
			this.accel = -1.2;
			return;
		}
		if (this.currentSpeed > this.targetSpeed) {
			this.accel = this.isPaceDown ? -0.5 : PhaseDeceleration[this.phase];
			return;
		}
		this.accel = this.baseAccel[+(this.hillIdx != -1) * 3 + this.phase];
		this.accel += this.modifiers.accel.acc + this.modifiers.accel.err;
	}

	updateHills() {
		if (this.hillIdx == -1 && this.hillStart.length > 0 && this.pos >= this.hillStart[this.hillStart.length - 1]) {
			if (this.course.slopes[this.nHills - this.hillStart.length].slope > 0) {
				this.hillIdx = this.nHills - this.hillStart.length;
			} else {
				this.hillEnd.pop();
			}
			this.hillStart.pop();
		} else if (this.hillIdx != -1 && this.hillEnd.length > 0 && this.pos > this.hillEnd[this.hillEnd.length - 1]) {
			this.hillIdx = -1;
			this.hillEnd.pop();
		}
	}

	updatePhase() {
		// NB. there is actually a phase 3 which starts at 5/6 distance, but for purposes of
		// strategy phase modifiers, activate_count_end_after, etc it is the same as phase 2
		// and it's easier to treat them together, so cap phase at 2.
		if (this.pos >= this.nextPhaseTransition && this.phase < 2) {
			++this.phase;
			this.nextPhaseTransition = courseHelpers.phaseStart(this.course.distance, this.phase + 1 as Phase);
		}
	}

	processSkillActivations() {
		for (let i = this.activeTargetSpeedSkills.length; --i >= 0;) {
			const s = this.activeTargetSpeedSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeTargetSpeedSkills.splice(i,1);
				this.modifiers.targetSpeed.add(-s.modifier);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeCurrentSpeedSkills.length; --i >= 0;) {
			const s = this.activeCurrentSpeedSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeCurrentSpeedSkills.splice(i,1);
				this.modifiers.currentSpeed.add(-s.modifier);
				if (s.naturalDeceleration) {
					this.modifiers.oneFrameAccel += s.modifier;
				}
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeAccelSkills.length; --i >= 0;) {
			const s = this.activeAccelSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeAccelSkills.splice(i,1);
				this.modifiers.accel.add(-s.modifier);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.pendingSkills.length; --i >= 0;) {
			const s = this.pendingSkills[i];
			if (this.pos >= s.trigger.end || this.pendingRemoval.has(s.skillId)) {  // NB. `Region`s are half-open [start,end) intervals. If pos == end we are out of the trigger.
				// skill failed to activate
				this.pendingSkills.splice(i,1);
				this.pendingRemoval.delete(s.skillId);
			} else if (this.pos >= s.trigger.start && s.extraCondition(this)) {
				this.activateSkill(s);
				this.pendingSkills.splice(i,1);
			}
		}
	}

	activateSkill(s: PendingSkill) {
		// sort so that the ExtendEvolvedDuration effect always activates after other effects, since it shouldn't extend the duration of other
		// effects on the same skill
		s.effects.sort((a,b) => +(a.type == 42) - +(b.type == 42)).forEach(ef => {
			const scaledDuration = ef.baseDuration * (this.course.distance / 1000) *
				(s.rarity == SkillRarity.Evolution ? this.modifiers.specialSkillDurationScaling : 1);  // TODO should probably be awakened skills
				                                                                                       // and not just pinks
			switch (ef.type) {
			case SkillType.SpeedUp:
				this.horse.speed = Math.max(this.horse.speed + ef.modifier, 1);
				break;
			case SkillType.StaminaUp:
				this.horse.stamina = Math.max(this.horse.stamina + ef.modifier, 1);
				this.horse.rawStamina = Math.max(this.horse.rawStamina + ef.modifier, 1);
				break;
			case SkillType.PowerUp:
				this.horse.power = Math.max(this.horse.power + ef.modifier, 1);
				break;
			case SkillType.GutsUp:
				this.horse.guts = Math.max(this.horse.guts + ef.modifier, 1);
				break;
			case SkillType.WisdomUp:
				this.horse.wisdom = Math.max(this.horse.wisdom + ef.modifier, 1);
				break;
			case SkillType.MultiplyStartDelay:
				this.startDelay *= ef.modifier;
				break;
			case SkillType.SetStartDelay:
				this.startDelay = ef.modifier;
				break;
			case SkillType.TargetSpeed:
				this.modifiers.targetSpeed.add(ef.modifier);
				this.activeTargetSpeedSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			case SkillType.Accel:
				this.modifiers.accel.add(ef.modifier);
				this.activeAccelSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			case SkillType.CurrentSpeed:
			case SkillType.CurrentSpeedWithNaturalDeceleration:
				this.modifiers.currentSpeed.add(ef.modifier);
				this.activeCurrentSpeedSkills.push({
					skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier,
					naturalDeceleration: ef.type == SkillType.CurrentSpeedWithNaturalDeceleration
				});
				break;
			case SkillType.Recovery:
				++this.activateCountHeal;
				this.hp.recover(ef.modifier);
				if (!CC_GLOBAL && this.phase >= 2 && !this.isLastSpurt) {
					this.updateLastSpurtState();
				}
				break;
			case SkillType.ActivateRandomGold:
				this.doActivateRandomGold(ef.modifier);
				break;
			case SkillType.ExtendEvolvedDuration:
				this.modifiers.specialSkillDurationScaling = ef.modifier;
				break;
			}
		});
		++this.activateCount[this.phase];
		this.usedSkills.add(s.skillId);
		this.onSkillActivate(this, s.skillId, s.perspective);
	}

	doActivateRandomGold(ngolds: number) {
		const goldIndices = this.pendingSkills.reduce((acc, skill, i) => {
			if ((skill.rarity == SkillRarity.Gold || skill.rarity == SkillRarity.Evolution) && skill.effects.every(ef => ef.type > SkillType.WisdomUp)) acc.push(i);
			return acc;
		}, []);
		for (let i = goldIndices.length; --i >= 0;) {
			const j = this.gorosiRng.uniform(i + 1);
			[goldIndices[i], goldIndices[j]] = [goldIndices[j], goldIndices[i]];
		}
		for (let i = 0; i < Math.min(ngolds, goldIndices.length); ++i) {
			const s = this.pendingSkills[goldIndices[i]];
			this.activateSkill(s);
			// important: we can't actually remove this from pendingSkills directly, since this function runs inside the loop in
			// processSkillActivations. modifying the pendingSkills array here would mess up that loop. this function used to modify
			// the trigger on the skill itself to ensure it was before this.pos and force it to be cleaned up, but mutating the skill
			// is error-prone and undesirable since it means the same PendingSkill instance can't be used with multiple RaceSolvers.
			// instead, flag the skill later to be removed in processSkillActivations (either later in the loop that called us, or
			// the next time processSkillActivations is called).
			this.pendingRemoval.add(s.skillId);
		}
	}

	// deactivate any skills that haven't finished their durations yet (intended to be called at the end of a simulation, when a skill
	// might have activated towards the end of the race and the race finished before the skill's duration)
	cleanup() {
		const callDeactivateHook = (value) => { this.onSkillDeactivate(this, value.skillId, value.perspective); }
		this.activeTargetSpeedSkills.forEach(callDeactivateHook);
		this.activeCurrentSpeedSkills.forEach(callDeactivateHook);
		this.activeAccelSkills.forEach(callDeactivateHook);
	}
}

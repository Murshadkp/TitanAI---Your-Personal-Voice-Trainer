
export enum CoachStyle {
  STRICT = 'Strict Coach',
  CALM = 'Calm Guide',
  FRIENDLY = 'Friendly Trainer'
}

export enum FitnessGoal {
  FAT_LOSS = 'Fat Loss',
  STRENGTH = 'Strength',
  HYPERTROPHY = 'Hypertrophy',
  ENDURANCE = 'Endurance'
}

export enum ExperienceLevel {
  BEGINNER = 'Beginner',
  INTERMEDIATE = 'Intermediate',
  ADVANCED = 'Advanced'
}

export enum Difficulty {
  EASY = 'Easy',
  MEDIUM = 'Moderate',
  HARD = 'Challenging'
}

// Added UserProfile interface to fix compilation errors in Dashboard, Onboarding and App components
export interface UserProfile {
  name: string;
  age: number;
  weight: number;
  height: number;
  goal: FitnessGoal;
  experience: ExperienceLevel;
  coachStyle: CoachStyle;
}

export interface Exercise {
  id: string;
  name: string;
  muscleGroup: string;
  description: string;
  targetReps: number;
  targetSets: number;
  restSeconds: number;
  difficulty?: Difficulty;
}

export interface WorkoutSession {
  id: string;
  date: string;
  exercises: {
    exerciseId: string;
    sets: { reps: number; weight?: number; rpe?: number }[];
  }[];
}

export interface WorkoutState {
  isActive: boolean;
  currentExerciseIndex: number;
  currentSet: number;
  timer: number;
  isResting: boolean;
}
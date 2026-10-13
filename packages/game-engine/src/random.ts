export type RandomSource = () => number;

export function randomIndex(length: number, random: RandomSource): number {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new RangeError(
      'Random selection length must be a positive safe integer',
    );
  }

  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError(
      'Random source must return a finite number in the range [0, 1)',
    );
  }

  return Math.floor(value * length);
}

export function shuffleCards<T>(
  input: readonly T[],
  random: RandomSource,
): T[] {
  const shuffled = [...input];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, random);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex]!,
      shuffled[index]!,
    ];
  }

  return shuffled;
}

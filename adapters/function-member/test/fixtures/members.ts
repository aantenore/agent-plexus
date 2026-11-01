export const answer = (input: unknown) => `echo:${typeof input === 'string' ? input : JSON.stringify(input)}`;
export const notAFunction = 42;
export default () => 'default-export';

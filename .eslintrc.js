module.exports = {
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "sourceType": "module",
    "ecmaVersion": 6,
  },
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",  // Uses the recommended rules from the @typescript-eslint/eslint-plugin
    "prettier",
    "prettier/@typescript-eslint",  // Uses eslint-config-prettier to disable ESLint rules from @typescript-eslint/eslint-plugin that would conflict with prettier
    "plugin:prettier/recommended",  // Enables eslint-plugin-prettier and displays prettier errors as ESLint errors. Make sure this is always the last configuration in the extends array.
  ],
  "rules": {
    "@typescript-eslint/no-unused-vars": 'off',
    "@typescript-eslint/no-use-before-define": 'off',
    "@typescript-eslint/no-var-requires": 'off',
    "@typescript-eslint/explicit-function-return-type": 'off',
    "@typescript-eslint/no-explicit-any": 'off',
  },
  "env": {
    "commonjs": true,
    "es6": true,
  },
  "globals": {
    "__dirname": true,
  },
};


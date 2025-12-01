// commitlint.config.js
export default {
    extends: ['@commitlint/config-conventional'],
    rules: {
      // 1. Enforce your specific commit types
      'type-enum': [
        2,
        'always',
        [
          'add',
          'update',
          'remove',
          'fix',
          'improve',
        ]
      ],
      // 2. Enforce lowercase types (e.g., 'add' not 'Add')
      'type-case': [2, 'always', 'lowercase'],
      
      // 3. Disable scopes (Your example is "type: desc", not "type(scope): desc")
      'scope-empty': [2, 'always'],
      
      // 4. Ensure there is a subject (description)
      'subject-empty': [2, 'never'],
      
      // 5. Ensure the subject does not end with a period
      'subject-full-stop': [2, 'never', '.'],
      
      // 6. Max length of the header (72 is standard for git legibility)
      'header-max-length': [2, 'always', 72],
    },
    ignores: [(commit) => commit === ""],

    defaultIgnores: true,
  };
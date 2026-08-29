import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**', '*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'cesium', message: 'Cesium 仅允许在 src/infra/** 引用（CLAUDE.md §4.1，子路径由 check-arch 覆盖）' },
            { name: 'maplibre-gl', message: 'MapLibre 仅允许在 src/infra/** 引用（CLAUDE.md §4.1，子路径由 check-arch 覆盖）' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/infra/**'],
    rules: {
      'no-restricted-imports': 'off',
    },
  }
)

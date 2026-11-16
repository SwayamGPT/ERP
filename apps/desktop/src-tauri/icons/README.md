Platform icons generated from `app-icon.png` (the Hisaab ledger-book mark on navy). To regenerate after changing the logo:

    npx tauri icon src-tauri/icons/app-icon.png -o src-tauri/icons

`android/` holds the phone launcher icons (the same mark, smaller, so Android's round and squircle
masks don't clip it, on a #154456 background). The Android workflow copies them into the generated
project after `tauri android init`.

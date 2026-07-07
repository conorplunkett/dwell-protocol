use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapError {
    AlreadyInitialized,
    NotInitialized,
    NotAuthority,
    InsufficientVaultBalance,
}

impl From<SwapError> for ProgramError {
    fn from(e: SwapError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

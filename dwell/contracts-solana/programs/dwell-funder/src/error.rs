use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunderError {
    AlreadyInitialized,
    NotInitialized,
    NotOwner,
    NotKeeper,
    Paused,
    AlreadyFunded,
    InsufficientOutput,
    BadBps,
    KeeperUnset,
}

impl From<FunderError> for ProgramError {
    fn from(e: FunderError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

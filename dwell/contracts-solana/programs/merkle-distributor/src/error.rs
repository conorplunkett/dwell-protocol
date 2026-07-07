use solana_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistributorError {
    AlreadyInitialized,
    NotInitialized,
    NotOwner,
    NotRootSetter,
    Paused,
    WrongEpoch,
    InvalidProof,
    NothingToClaim,
}

impl From<DistributorError> for ProgramError {
    fn from(e: DistributorError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

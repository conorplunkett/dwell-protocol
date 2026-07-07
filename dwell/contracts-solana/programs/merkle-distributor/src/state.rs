use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const DISTRIBUTOR_STATE_SEED: &[u8] = b"distributor_state";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
pub const CLAIM_STATUS_SEED: &[u8] = b"claim_status";

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct DistributorState {
    pub is_initialized: bool,
    /// Stands in for the treasury Safe: pause/unpause, rotate root_setter.
    /// Can never move vault funds — only `claim` moves tokens, and only to
    /// the leaf's wallet.
    pub owner: Pubkey,
    pub root_setter: Pubkey,
    pub dwell_mint: Pubkey,
    pub root: [u8; 32],
    pub epoch: u64,
    pub is_paused: bool,
    pub total_claimed: u64,
}

impl DistributorState {
    pub const LEN: usize = 1 + 32 + 32 + 32 + 32 + 8 + 1 + 8;
}

/// One per wallet, created lazily on first claim. `claimed` only grows.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct ClaimStatus {
    pub is_initialized: bool,
    pub claimed: u64,
}

impl ClaimStatus {
    pub const LEN: usize = 1 + 8;
}

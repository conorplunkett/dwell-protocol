use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

pub const FUNDER_STATE_SEED: &[u8] = b"funder_state";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
pub const DISTRIBUTOR_AUTHORITY_SEED: &[u8] = b"distributor_authority";
pub const CAMPAIGN_SEED: &[u8] = b"campaign";

pub const BPS: u64 = 10_000;

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct FunderState {
    pub is_initialized: bool,
    /// Stands in for the treasury Safe — can set the keeper, shares, pause.
    pub owner: Pubkey,
    /// Single backend keeper key. A dry-run simplification of the EVM
    /// contract's `mapping(address => bool) keepers`; a production Solana
    /// port would want the same multi-keeper allowlist shape.
    pub keeper: Pubkey,
    pub treasury: Pubkey,
    pub dwell_mint: Pubkey,
    pub usdc_mint: Pubkey,
    /// Owner-set CPI target — the analogue of `CampaignFunder.swapTarget`.
    pub swap_program: Pubkey,
    pub treasury_bps: u16,
    pub is_paused: bool,
    pub total_usdc_spent: u64,
    pub total_dwell_to_distributor: u64,
    pub total_dwell_to_treasury: u64,
}

impl FunderState {
    pub const LEN: usize = 1 + 32 + 32 + 32 + 32 + 32 + 32 + 2 + 1 + 8 + 8 + 8;
}

/// Created once per campaign_id on first successful fund — its mere
/// existence is the `AlreadyFunded` guard (a second `create_account` at the
/// same PDA fails outright).
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct CampaignFunded {
    pub is_initialized: bool,
    pub usdc_in: u64,
    pub dwell_out: u64,
    pub to_distributor: u64,
    pub to_treasury: u64,
}

impl CampaignFunded {
    pub const LEN: usize = 1 + 8 + 8 + 8 + 8;
}

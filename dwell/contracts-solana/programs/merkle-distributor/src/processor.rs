use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    keccak,
    msg,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use crate::error::DistributorError;
use crate::instruction::DistributorInstruction;
use crate::state::{ClaimStatus, DistributorState, CLAIM_STATUS_SEED, DISTRIBUTOR_STATE_SEED, VAULT_AUTHORITY_SEED};

pub fn process<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], data: &[u8]) -> ProgramResult {
    let ix = DistributorInstruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        DistributorInstruction::Initialize => initialize(program_id, accounts),
        DistributorInstruction::SetRoot { root, new_epoch, total_newly_allocated } => {
            set_root(program_id, accounts, root, new_epoch, total_newly_allocated)
        }
        DistributorInstruction::SetRootSetter { root_setter } => {
            set_root_setter(program_id, accounts, Pubkey::new_from_array(root_setter))
        }
        DistributorInstruction::Pause => set_paused(program_id, accounts, true),
        DistributorInstruction::Unpause => set_paused(program_id, accounts, false),
        DistributorInstruction::Claim { cumulative_amount, proof } => {
            claim(program_id, accounts, cumulative_amount, &proof)
        }
    }
}

fn state_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[DISTRIBUTOR_STATE_SEED], program_id)
}

fn load_state(ai: &AccountInfo) -> Result<DistributorState, ProgramError> {
    let s = DistributorState::try_from_slice(&ai.data.borrow())?;
    if !s.is_initialized {
        return Err(DistributorError::NotInitialized.into());
    }
    Ok(s)
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let state_ai = next_account_info(iter)?;
    let root_setter = next_account_info(iter)?;
    let dwell_mint = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected, bump) = state_pda(program_id);
    if expected != *state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if state_ai.data_len() > 0 && !state_ai.data.borrow().iter().all(|b| *b == 0) {
        return Err(DistributorError::AlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            state_ai.key,
            rent.minimum_balance(DistributorState::LEN),
            DistributorState::LEN as u64,
            program_id,
        ),
        &[payer.clone(), state_ai.clone(), system_program.clone()],
        &[&[DISTRIBUTOR_STATE_SEED, &[bump]]],
    )?;

    let state = DistributorState {
        is_initialized: true,
        owner: *payer.key,
        root_setter: *root_setter.key,
        dwell_mint: *dwell_mint.key,
        root: [0u8; 32],
        epoch: 0,
        is_paused: false,
        total_claimed: 0,
    };
    state.serialize(&mut &mut state_ai.data.borrow_mut()[..])?;
    msg!("merkle-distributor: initialized, root_setter={}", root_setter.key);
    Ok(())
}

fn set_root(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    root: [u8; 32],
    new_epoch: u64,
    total_newly_allocated: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let root_setter = next_account_info(iter)?;
    let state_ai = next_account_info(iter)?;

    if !root_setter.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected, _) = state_pda(program_id);
    if expected != *state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let mut state = load_state(state_ai)?;
    if state.root_setter != *root_setter.key {
        return Err(DistributorError::NotRootSetter.into());
    }
    if new_epoch != state.epoch + 1 {
        return Err(DistributorError::WrongEpoch.into());
    }
    state.root = root;
    state.epoch = new_epoch;
    state.serialize(&mut &mut state_ai.data.borrow_mut()[..])?;
    msg!(
        "RootUpdated epoch={} total_newly_allocated={}",
        new_epoch,
        total_newly_allocated
    );
    Ok(())
}

fn require_owner<'a>(
    program_id: &Pubkey,
    accounts: &'a [AccountInfo<'a>],
) -> Result<(AccountInfo<'a>, DistributorState), ProgramError> {
    let iter = &mut accounts.iter();
    let owner = next_account_info(iter)?.clone();
    let state_ai = next_account_info(iter)?.clone();
    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected, _) = state_pda(program_id);
    if expected != *state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let state = load_state(&state_ai)?;
    if state.owner != *owner.key {
        return Err(DistributorError::NotOwner.into());
    }
    Ok((state_ai, state))
}

fn set_root_setter<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], new_setter: Pubkey) -> ProgramResult {
    let (state_ai, mut state) = require_owner(program_id, accounts)?;
    state.root_setter = new_setter;
    state.serialize(&mut &mut state_ai.data.borrow_mut()[..])?;
    msg!("merkle-distributor: root_setter rotated to {}", new_setter);
    Ok(())
}

fn set_paused<'a>(program_id: &Pubkey, accounts: &'a [AccountInfo<'a>], paused: bool) -> ProgramResult {
    let (state_ai, mut state) = require_owner(program_id, accounts)?;
    state.is_paused = paused;
    state.serialize(&mut &mut state_ai.data.borrow_mut()[..])?;
    msg!("merkle-distributor: is_paused = {}", paused);
    Ok(())
}

/// OZ StandardMerkleTree leaf: keccak256(keccak256(abi.encode(wallet, amount))).
/// `abi.encode(bytes32, uint256)` = 32-byte wallet ‖ 32-byte big-endian amount —
/// a Solana pubkey is already 32 bytes, so the wallet slots in unchanged.
fn leaf_hash(wallet: &Pubkey, cumulative_amount: u64) -> [u8; 32] {
    let mut amt = [0u8; 32];
    amt[24..].copy_from_slice(&cumulative_amount.to_be_bytes());
    let inner = keccak::hashv(&[wallet.as_ref(), &amt]);
    keccak::hashv(&[inner.as_ref()]).0
}

fn verify_proof(root: &[u8; 32], leaf: [u8; 32], proof: &[[u8; 32]]) -> bool {
    let mut node = leaf;
    for sibling in proof {
        let (a, b) = if node <= *sibling { (node, *sibling) } else { (*sibling, node) };
        node = keccak::hashv(&[&a, &b]).0;
    }
    node == *root
}

fn claim(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    cumulative_amount: u64,
    proof: &[[u8; 32]],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let state_ai = next_account_info(iter)?;
    let claim_status_ai = next_account_info(iter)?;
    let wallet = next_account_info(iter)?;
    let vault_authority_ai = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let wallet_dwell_account = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected_state, _) = state_pda(program_id);
    if expected_state != *state_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let mut state = load_state(state_ai)?;
    if state.is_paused {
        return Err(DistributorError::Paused.into());
    }

    // Funds only ever go TO the leaf wallet: the destination token account's
    // owner must be the wallet baked into the proven leaf.
    {
        // SPL token account layout: mint [0..32], owner [32..64]
        let data = wallet_dwell_account.data.borrow();
        if data.len() < 64
            || data[0..32] != state.dwell_mint.to_bytes()
            || data[32..64] != wallet.key.to_bytes()
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }

    if !verify_proof(&state.root, leaf_hash(wallet.key, cumulative_amount), proof) {
        return Err(DistributorError::InvalidProof.into());
    }

    let (expected_claim, claim_bump) =
        Pubkey::find_program_address(&[CLAIM_STATUS_SEED, wallet.key.as_ref()], program_id);
    if expected_claim != *claim_status_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let already = if claim_status_ai.lamports() == 0 {
        let rent = Rent::get()?;
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                claim_status_ai.key,
                rent.minimum_balance(ClaimStatus::LEN),
                ClaimStatus::LEN as u64,
                program_id,
            ),
            &[payer.clone(), claim_status_ai.clone(), system_program.clone()],
            &[&[CLAIM_STATUS_SEED, wallet.key.as_ref(), &[claim_bump]]],
        )?;
        0u64
    } else {
        ClaimStatus::try_from_slice(&claim_status_ai.data.borrow())?.claimed
    };

    let delta = cumulative_amount
        .checked_sub(already)
        .ok_or::<ProgramError>(DistributorError::NothingToClaim.into())?;
    if delta == 0 {
        return Err(DistributorError::NothingToClaim.into());
    }

    // checks done — effects…
    let status = ClaimStatus { is_initialized: true, claimed: cumulative_amount };
    status.serialize(&mut &mut claim_status_ai.data.borrow_mut()[..])?;
    state.total_claimed = state
        .total_claimed
        .checked_add(delta)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    state.serialize(&mut &mut state_ai.data.borrow_mut()[..])?;

    // …then interaction.
    let (expected_vault_authority, vault_bump) =
        Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED], program_id);
    if expected_vault_authority != *vault_authority_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    let mut ix_data = Vec::with_capacity(9);
    ix_data.push(3u8); // SPL Token Transfer
    ix_data.extend_from_slice(&delta.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: *token_program.key,
            accounts: vec![
                AccountMeta::new(*vault.key, false),
                AccountMeta::new(*wallet_dwell_account.key, false),
                AccountMeta::new_readonly(*vault_authority_ai.key, false),
            ],
            data: ix_data,
        },
        &[
            vault.clone(),
            wallet_dwell_account.clone(),
            vault_authority_ai.clone(),
            token_program.clone(),
        ],
        &[&[VAULT_AUTHORITY_SEED, &[vault_bump]]],
    )?;

    msg!("Claimed wallet={} amount={} cumulative={}", wallet.key, delta, cumulative_amount);
    Ok(())
}
